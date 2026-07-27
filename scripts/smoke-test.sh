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
# failure exits 1 so the deploy workflow goes red.
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
UNKNOWN_NUMBER="+15555550123"
FAILURES=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
skip() { echo "SKIP: $1"; }

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
if [ -z "$CLIENT_ID" ]; then
    fail "auth checks: no UserPoolClientID output on $STACK_NAME"
else
    unknown_out=$(aws cognito-idp initiate-auth \
        --auth-flow CUSTOM_AUTH \
        --client-id "$CLIENT_ID" \
        --auth-parameters USERNAME="$UNKNOWN_NUMBER" 2>&1)
    unknown_status=$?

    if [ "$unknown_status" -eq 0 ]; then
        fail "unknown number was issued an auth challenge (PreventUserExistenceErrors regression): $unknown_out"
    elif grep -q "NotAuthorizedException" <<<"$unknown_out"; then
        pass "unknown number rejected with NotAuthorizedException"
    else
        fail "unknown number got an unexpected error: $unknown_out"
    fi
fi

# --- 2. Known test user reaches the language handshake (no SMS in round 1) ---
# Requires a permanent, confirmed test user whose phone number is stored at
# /a-iep/<env>/smoke-test-phone in SSM. The session is abandoned after round
# 1, which by design sends no SMS.
TEST_PHONE=$(aws ssm get-parameter --name "/a-iep/${ENV_NAME}/smoke-test-phone" \
    --query 'Parameter.Value' --output text 2>/dev/null || true)
if [ -z "${TEST_PHONE:-}" ] || [ "$TEST_PHONE" = "None" ]; then
    skip "test-user handshake (no /a-iep/${ENV_NAME}/smoke-test-phone SSM parameter)"
elif [ -n "$CLIENT_ID" ]; then
    known_out=$(aws cognito-idp initiate-auth \
        --auth-flow CUSTOM_AUTH \
        --client-id "$CLIENT_ID" \
        --auth-parameters USERNAME="$TEST_PHONE" 2>&1)
    known_status=$?

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
if [ -z "$SITE_URL" ]; then
    fail "site check: no UserInterfaceDomainName output on $STACK_NAME"
else
    index_html=$(curl -fsS --max-time 30 "$SITE_URL/") || index_html=""
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
            if curl -fsSI --max-time 30 "$bundle_url" >/dev/null; then
                pass "site serves index.html and its hashed bundle ($bundle)"
            else
                fail "index.html references $bundle but it is not fetchable"
            fi
        fi
    fi
fi

# --- 4. The API answers (auth rejection is the healthy signal) ---------------
if [ -z "$API_ENDPOINT" ]; then
    fail "api check: no HTTPAPIapiEndpoint output on $STACK_NAME"
else
    api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${API_ENDPOINT}/profile")
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
