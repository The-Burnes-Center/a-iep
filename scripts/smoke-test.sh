#!/usr/bin/env bash
# Post-deploy smoke tests (Phase 2 of the testing protocol).
#
#   usage: smoke-test.sh <stack-name> <environment>
#          smoke-test.sh AIEPStagingStack staging
#          smoke-test.sh AIEPStack production
#
# Every check is read-only and SMS-free. All endpoints and IDs are resolved
# from CloudFormation stack outputs at runtime, so nothing here goes stale
# when the stacks change. Checks run to completion and report together; any
# failure exits 1 so the deploy workflow goes red. Network probes retry up
# to 3 times, ~10s apart, so a single CloudFront/API propagation blip right
# after a deploy does not fail the run; every retry is logged.
#
# Check 1 is the regression that motivated all of this (PR #51): an unknown
# phone number must be rejected with NotAuthorizedException. Before the fix
# it received a CUSTOM_CHALLENGE whose ChallengeParameters carried an error
# string, the frontend never read it, and signup was silently broken for a
# month.
set -uo pipefail

STACK_NAME="${1:?usage: smoke-test.sh <stack-name> <environment>}"
ENV_NAME="${2:?usage: smoke-test.sh <stack-name> <environment>}"

# A number in the SMS-reserved 555-01XX fictional range: never a real user.
# The permanent smoke-test users (also fictional, created 2026-07-27 via
# admin-create-user + permanent random password, phone_number_verified) are
# +15555550101 (staging) and +15555550102 (production), stored in SSM at
# /a-iep/<env>/smoke-test-phone. UNKNOWN_NUMBER must stay distinct from
# them or check 1 would hit a real account.
UNKNOWN_NUMBER="+15555550123"
FAILURES=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# retry <label> <attempt-fn>: run the attempt up to 3 times, ~10s apart, so a
# single CloudFront/API propagation blip right after a deploy does not fail
# the run. An attempt returns 0 once its outcome is settled (for check 1 that
# includes the expected rejection); anything else is treated as possibly
# transient. Each retry is logged so the output stays honest, and the checks
# below judge the final outcome themselves.
RETRY_ATTEMPTS=3
RETRY_DELAY=10
retry() {
    local label="$1"; shift
    local attempt rc=0
    for attempt in $(seq 1 "$RETRY_ATTEMPTS"); do
        "$@" && return 0
        rc=$?
        if [ "$attempt" -lt "$RETRY_ATTEMPTS" ]; then
            echo "  retry: $label failed (attempt $attempt/$RETRY_ATTEMPTS); trying again in ${RETRY_DELAY}s"
            sleep "$RETRY_DELAY"
        fi
    done
    return "$rc"
}

# --- Resolve everything from stack outputs -----------------------------------
outputs=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs" --output json) || {
    echo "FATAL: could not read outputs for stack $STACK_NAME"
    exit 1
}
output_like() {
    jq -r --arg pattern "$1" \
        '[.[] | select(.OutputKey | test($pattern))][0].OutputValue // empty' <<<"$outputs"
}

CLIENT_ID=$(output_like 'UserPoolClientID')
API_ENDPOINT=$(output_like 'HTTPAPIapiEndpoint')
SITE_URL=$(output_like 'UserInterfaceDomainName')

echo "Stack: $STACK_NAME ($ENV_NAME)"
echo "  client id:    ${CLIENT_ID:-<missing>}"
echo "  api endpoint: ${API_ENDPOINT:-<missing>}"
echo "  site url:     ${SITE_URL:-<missing>}"
echo

# --- 1. Unknown number must be rejected, not challenged ----------------------
# Settled outcomes: an auth challenge (exit 0, the regression) or the expected
# NotAuthorizedException. Any other error may be a transient blip, so retry.
attempt_unknown_auth() {
    unknown_out=$(aws cognito-idp initiate-auth \
        --auth-flow CUSTOM_AUTH \
        --client-id "$CLIENT_ID" \
        --auth-parameters USERNAME="$UNKNOWN_NUMBER" 2>&1)
    unknown_status=$?
    [ "$unknown_status" -eq 0 ] && return 0
    grep -q "NotAuthorizedException" <<<"$unknown_out"
}
if [ -z "$CLIENT_ID" ]; then
    fail "auth checks: no UserPoolClientID output on $STACK_NAME"
else
    retry "unknown-number initiate-auth" attempt_unknown_auth

    if [ "$unknown_status" -eq 0 ]; then
        fail "unknown number was issued an auth challenge (PreventUserExistenceErrors regression): $unknown_out"
    elif grep -q "NotAuthorizedException" <<<"$unknown_out"; then
        pass "unknown number rejected with NotAuthorizedException"
    else
        fail "unknown number got an unexpected error: $unknown_out"
    fi
fi

# --- 2. Known test user reaches the language handshake (no SMS in round 1) ---
# Uses the permanent smoke-test user whose phone number is stored at
# /a-iep/<env>/smoke-test-phone in SSM. The session is abandoned after round
# 1, which by design sends no SMS (so retrying is SMS-free too). A wrong
# challenge is a settled failure; only transport errors are retried.
attempt_known_auth() {
    known_out=$(aws cognito-idp initiate-auth \
        --auth-flow CUSTOM_AUTH \
        --client-id "$CLIENT_ID" \
        --auth-parameters USERNAME="$TEST_PHONE" 2>&1)
    known_status=$?
    return "$known_status"
}
TEST_PHONE=$(aws ssm get-parameter --name "/a-iep/${ENV_NAME}/smoke-test-phone" \
    --query 'Parameter.Value' --output text 2>/dev/null || true)
if [ -z "${TEST_PHONE:-}" ] || [ "$TEST_PHONE" = "None" ]; then
    fail "test-user handshake: SSM parameter /a-iep/${ENV_NAME}/smoke-test-phone is missing. Permanent smoke-test users exist in both envs (staging +15555550101, production +15555550102, created 2026-07-27), so a missing parameter means the user or parameter was deleted; restore it instead of skipping this check"
elif [ -n "$CLIENT_ID" ]; then
    retry "test-user initiate-auth" attempt_known_auth

    if [ "$known_status" -ne 0 ]; then
        fail "test user could not start auth: $known_out"
    else
        challenge=$(jq -r '.ChallengeName // empty' <<<"$known_out")
        challenge_type=$(jq -r '.ChallengeParameters.challengeType // empty' <<<"$known_out")
        challenge_error=$(jq -r '.ChallengeParameters.error // empty' <<<"$known_out")
        if [ "$challenge" = "CUSTOM_CHALLENGE" ] && [ "$challenge_type" = "LANGUAGE_HANDSHAKE" ] && [ -z "$challenge_error" ]; then
            pass "test user reached the language handshake with no error"
        else
            fail "test user handshake wrong (challenge=$challenge type=$challenge_type error=$challenge_error)"
        fi
    fi
fi

# --- 3. The frontend actually shipped -----------------------------------------
attempt_index_fetch() {
    index_html=$(curl -fsS --max-time 30 "$SITE_URL/") && [ -n "$index_html" ]
}
attempt_bundle_head() {
    curl -fsSI --max-time 30 "$bundle_url" >/dev/null
}
if [ -z "$SITE_URL" ]; then
    fail "site check: no UserInterfaceDomainName output on $STACK_NAME"
else
    retry "site index fetch" attempt_index_fetch || index_html=""
    if [ -z "$index_html" ]; then
        fail "could not fetch $SITE_URL/"
    else
        bundle=$(grep -oE 'src="[^"]+\.js"' <<<"$index_html" | head -1 | sed 's/^src="//; s/"$//')
        if [ -z "$bundle" ]; then
            fail "index.html has no script bundle reference"
        else
            case "$bundle" in
                http*) bundle_url="$bundle" ;;
                *)     bundle_url="${SITE_URL}${bundle}" ;;
            esac
            if retry "bundle fetch" attempt_bundle_head; then
                pass "site serves index.html and its hashed bundle ($bundle)"
            else
                fail "index.html references $bundle but it is not fetchable"
            fi
        fi
    fi
fi

# --- 4. The API answers (auth rejection is the healthy signal) ---------------
# 401/403 is the settled healthy outcome; 000/5xx/anything else may be a
# propagation blip, so retry before judging the final code.
attempt_api_probe() {
    api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${API_ENDPOINT}/profile")
    case "$api_code" in
        401|403) return 0 ;;
        *)       return 1 ;;
    esac
}
if [ -z "$API_ENDPOINT" ]; then
    fail "api check: no HTTPAPIapiEndpoint output on $STACK_NAME"
else
    retry "API /profile probe" attempt_api_probe
    case "$api_code" in
        401|403) pass "API is up and enforcing auth (/profile -> $api_code)" ;;
        *)       fail "API /profile returned $api_code (expected 401/403)" ;;
    esac
fi

echo
if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES smoke check(s) FAILED for $STACK_NAME"
    exit 1
fi
echo "All smoke checks passed for $STACK_NAME"
