#!/usr/bin/env bash
# Post-deploy smoke tests (Phase 2 of the testing protocol).
#
#   usage: smoke-test.sh <stack-name> <environment>
#          smoke-test.sh AIEPStagingStack staging
#          smoke-test.sh AIEPStack production
#
# Every check is read-only and SMS-free. All endpoints and IDs are resolved
# from CloudFormation stack outputs (and the backend client from its fixed
# name) at runtime, so nothing here goes stale when the stacks change. Checks run to completion and report together; any
# failure exits 1 so the deploy workflow goes red. Network probes retry up
# to 3 times, ~10s apart, so a single CloudFront/API propagation blip right
# after a deploy does not fail the run; every retry is logged.
#
# Check 1 is the regression that motivated all of this (PR #51): an unknown
# phone number must be rejected with NotAuthorizedException. Before the fix
# it received a CUSTOM_CHALLENGE whose ChallengeParameters carried an error
# string, the frontend never read it, and signup was silently broken for a
# month. Checks 1 and 2 run on the backend app client, the only one that can
# start a sign-in; check 0 pins that the browser's client cannot.
#
# Needs, beyond read access to the stack and SSM: cognito-idp
# ListUserPoolClients, DescribeUserPoolClient (for the backend client's
# secret, which is never printed) and AdminInitiateAuth on the pool.
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

# The browser app's client (its id ships in aws-exports.json) and the client
# only the backend holds. Sign-in runs on the second; the first may only
# refresh. The backend client's name is fixed in lib/authorization/new-auth.ts
# and pinned by test/infra, so it is looked up by name rather than needing a
# stack output of its own.
CLIENT_ID=$(output_like 'UserPoolClientID')
POOL_ID=$(output_like 'NewUserPoolID')
BACKEND_CLIENT_NAME="a-iep-backend-auth"
API_ENDPOINT=$(output_like 'HTTPAPIapiEndpoint')
SITE_URL=$(output_like 'UserInterfaceDomainName')

BACKEND_CLIENT_ID=""
BACKEND_CLIENT_SECRET=""
if [ -n "$POOL_ID" ]; then
    BACKEND_CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" \
        --max-results 60 --output json 2>/dev/null \
        | jq -r --arg name "$BACKEND_CLIENT_NAME" \
            '[.UserPoolClients[] | select(.ClientName == $name)] | if length == 1 then .[0].ClientId else empty end')
fi
if [ -n "$BACKEND_CLIENT_ID" ]; then
    BACKEND_CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" \
        --client-id "$BACKEND_CLIENT_ID" --query 'UserPoolClient.ClientSecret' --output text 2>/dev/null || true)
    [ "$BACKEND_CLIENT_SECRET" = "None" ] && BACKEND_CLIENT_SECRET=""
    # Never printed. Masked as well, so a future debugging echo on a GitHub
    # runner cannot put it in a public log.
    if [ -n "$BACKEND_CLIENT_SECRET" ] && [ -n "${GITHUB_ACTIONS:-}" ]; then
        echo "::add-mask::$BACKEND_CLIENT_SECRET"
    fi
fi

echo "Stack: $STACK_NAME ($ENV_NAME)"
echo "  pool id:           ${POOL_ID:-<missing>}"
echo "  browser client id: ${CLIENT_ID:-<missing>}"
echo "  backend client id: ${BACKEND_CLIENT_ID:-<missing>}"
echo "  api endpoint:      ${API_ENDPOINT:-<missing>}"
echo "  site url:          ${SITE_URL:-<missing>}"
echo

# SECRET_HASH for the backend client: base64(HMAC-SHA256(secret, username +
# client id)). Computed in python so the secret goes through the environment
# rather than a command line.
secret_hash() {
    SH_USERNAME="$1" SH_CLIENT_ID="$BACKEND_CLIENT_ID" SH_SECRET="$BACKEND_CLIENT_SECRET" python3 -c '
import base64, hashlib, hmac, os
message = (os.environ["SH_USERNAME"] + os.environ["SH_CLIENT_ID"]).encode()
digest = hmac.new(os.environ["SH_SECRET"].encode(), message, hashlib.sha256).digest()
print(base64.b64encode(digest).decode())'
}

# admin-initiate-auth CUSTOM_AUTH on the backend client, round 1 only. Round 1
# is the language handshake, which by design sends nothing; the session is
# abandoned there. Auth parameters go as JSON: a SECRET_HASH can contain '='
# and '/', which the CLI's shorthand syntax does not survive.
backend_initiate() {
    local username="$1" params
    params=$(jq -cn --arg u "$username" --arg h "$(secret_hash "$username")" \
        '{USERNAME: $u, SECRET_HASH: $h}')
    aws cognito-idp admin-initiate-auth \
        --user-pool-id "$POOL_ID" \
        --client-id "$BACKEND_CLIENT_ID" \
        --auth-flow CUSTOM_AUTH \
        --auth-parameters "$params" 2>&1
}

# --- 0. The browser's client cannot start a sign-in --------------------------
# Only the fictional unknown number is ever used here, so even a client that
# wrongly still allowed the flow would answer NotAuthorizedException and send
# nothing. Settled outcomes: InvalidParameterException saying the flow is not
# enabled (healthy), NotAuthorizedException or a challenge (the flow is still
# on). Anything else may be a blip, so retry.
attempt_browser_flow() {
    local flow="$1"
    shift
    browser_out=$(aws cognito-idp initiate-auth \
        --auth-flow "$flow" \
        --client-id "$CLIENT_ID" \
        --auth-parameters "$@" 2>&1)
    browser_status=$?
    [ "$browser_status" -eq 0 ] && return 0
    grep -qE "InvalidParameterException|NotAuthorizedException" <<<"$browser_out"
}
check_browser_flow_refused() {
    local flow="$1"
    shift
    retry "browser-client $flow" attempt_browser_flow "$flow" "$@"
    if [ "$browser_status" -ne 0 ] && grep -q "InvalidParameterException" <<<"$browser_out" \
        && grep -qi "not enabled" <<<"$browser_out"; then
        pass "browser client refuses $flow"
    elif [ "$browser_status" -eq 0 ] || grep -q "NotAuthorizedException" <<<"$browser_out"; then
        fail "browser client still accepts $flow (expected: flow not enabled for this client)"
    else
        fail "browser client $flow got an unexpected error: $browser_out"
    fi
}
if [ -z "$CLIENT_ID" ]; then
    fail "browser client checks: no UserPoolClientID output on $STACK_NAME"
else
    check_browser_flow_refused CUSTOM_AUTH USERNAME="$UNKNOWN_NUMBER"
    check_browser_flow_refused USER_PASSWORD_AUTH USERNAME="$UNKNOWN_NUMBER",PASSWORD="not-a-real-password-0"
fi

# --- 1. Unknown number must be rejected, not challenged ----------------------
# Settled outcomes: an auth challenge (exit 0, the regression) or the expected
# NotAuthorizedException. Any other error may be a transient blip, so retry.
attempt_unknown_auth() {
    unknown_out=$(backend_initiate "$UNKNOWN_NUMBER")
    unknown_status=$?
    [ "$unknown_status" -eq 0 ] && return 0
    grep -q "NotAuthorizedException" <<<"$unknown_out"
}
BACKEND_READY=""
if [ -z "$POOL_ID" ]; then
    fail "auth checks: no NewUserPoolID output on $STACK_NAME"
elif [ -z "$BACKEND_CLIENT_ID" ]; then
    fail "auth checks: no single app client named $BACKEND_CLIENT_NAME in $POOL_ID"
elif [ -z "$BACKEND_CLIENT_SECRET" ]; then
    fail "auth checks: could not read the secret of $BACKEND_CLIENT_NAME (needs cognito-idp:DescribeUserPoolClient)"
else
    BACKEND_READY=1
fi
if [ -n "$BACKEND_READY" ]; then
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
    known_out=$(backend_initiate "$TEST_PHONE")
    known_status=$?
    return "$known_status"
}
TEST_PHONE=$(aws ssm get-parameter --name "/a-iep/${ENV_NAME}/smoke-test-phone" \
    --query 'Parameter.Value' --output text 2>/dev/null || true)
if [ -z "${TEST_PHONE:-}" ] || [ "$TEST_PHONE" = "None" ]; then
    fail "test-user handshake: SSM parameter /a-iep/${ENV_NAME}/smoke-test-phone is missing. Permanent smoke-test users exist in both envs (staging +15555550101, production +15555550102, created 2026-07-27), so a missing parameter means the user or parameter was deleted; restore it instead of skipping this check"
elif [ -n "$BACKEND_READY" ]; then
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
