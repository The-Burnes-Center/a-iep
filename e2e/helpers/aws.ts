/**
 * AWS-side helpers: the OTP backdoor reader and the Cognito test-user
 * lifecycle. Everything here is admin-plane; the specs drive the actual
 * product through the browser only.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomBytes } from 'crypto';
import { REGION, TEST_OTP_PARAM_PREFIX, getUserPoolId } from './config';

const ssm = new SSMClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

export interface OtpPayload {
  code: string;
  language: string;
  issuedAt: string;
}

/**
 * How far the runner's clock may sit BEHIND the lambda's when judging
 * freshness. The dangerous direction is the runner being ahead (a genuinely
 * fresh code would look stale and we would poll into a timeout), so we give
 * the comparison a little slack. Two seconds can never resurrect a previous
 * run's parameter: consecutive sends for one number are minutes apart.
 */
const CLOCK_SKEW_ALLOWANCE_MS = 2_000;
const OTP_POLL_TIMEOUT_MS = 30_000;
const OTP_POLL_INTERVAL_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** SSM parameter names cannot contain '+', so the backdoor writes the E.164
 * number without it (see the contract in README.md). */
export function otpParameterName(phone: string): string {
  return `${TEST_OTP_PARAM_PREFIX}/${phone.replace('+', '')}`;
}

/**
 * Read the OTP the backdoor stashed for `phone`.
 *
 * The parameter persists between runs (it is overwritten per send, never
 * deleted), so reading it blindly would happily return LAST run's code.
 * Callers therefore capture a timestamp BEFORE triggering the send and we
 * only accept a payload whose issuedAt is newer than that; anything older is
 * a stale leftover and we keep polling.
 */
export async function fetchOtp(phone: string, notBeforeMs: number): Promise<OtpPayload> {
  const name = otpParameterName(phone);
  const acceptAfterMs = notBeforeMs - CLOCK_SKEW_ALLOWANCE_MS;
  const deadline = Date.now() + OTP_POLL_TIMEOUT_MS;
  let lastSeen = 'no parameter yet';

  while (Date.now() < deadline) {
    try {
      const result = await ssm.send(new GetParameterCommand({ Name: name }));
      const raw = result.Parameter?.Value ?? '';
      const payload = JSON.parse(raw) as OtpPayload;
      const issuedAtMs = Date.parse(payload.issuedAt);
      if (!Number.isNaN(issuedAtMs) && issuedAtMs >= acceptAfterMs) {
        return payload;
      }
      lastSeen = `stale payload issuedAt=${payload.issuedAt}`;
    } catch (error) {
      if ((error as Error).name !== 'ParameterNotFound') throw error;
      // Not written yet (first ever send for this number): keep polling.
    }
    await sleep(OTP_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out after ${OTP_POLL_TIMEOUT_MS / 1000}s waiting for a fresh OTP at ${name} ` +
    `(${lastSeen}). Either the backdoor did not fire (is ${phone} allowlisted in ` +
    'create-auth-challenge? is the backdoor deployed to staging?) or the send failed.'
  );
}

/**
 * A throwaway password that satisfies the pool policy (minLength 8, digits).
 * The OTP flow never uses passwords; this exists only because Cognito
 * requires AdminSetUserPassword(Permanent) to move an admin-created user
 * from FORCE_CHANGE_PASSWORD to CONFIRMED.
 */
function randomThrowawayPassword(): string {
  return `E2e9!${randomBytes(24).toString('base64url')}`;
}

/**
 * Idempotently make `phone` a CONFIRMED, phone-verified user, mirroring how
 * the permanent smoke users were created (admin-create-user, MessageAction
 * SUPPRESS, permanent random password; see docs/TESTING_PROTOCOL_PLAN.md).
 *
 * The attribute + password steps run even when the user already exists:
 * a leftover from the re-signup journey is UNCONFIRMED with an unverified
 * phone, and both calls repair exactly that (AdminSetUserPassword with
 * Permanent=true confirms the account as a side effect). The pool signs
 * users in by phone_number, so Cognito resolves the phone to the generated
 * UUID username in every call below.
 */
export async function ensureTestUser(phone: string): Promise<void> {
  const userPoolId = getUserPoolId();
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: phone,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'phone_number', Value: phone },
        { Name: 'phone_number_verified', Value: 'true' },
      ],
    }));
  } catch (error) {
    if ((error as Error).name !== 'UsernameExistsException') throw error;
  }

  await cognito.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: phone,
    UserAttributes: [{ Name: 'phone_number_verified', Value: 'true' }],
  }));

  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: phone,
    Password: randomThrowawayPassword(),
    Permanent: true,
  }));
}

/**
 * Remove `phone`'s Cognito user, tolerating absence. Used to heal the
 * throwaway number before the re-signup journey: a previous run leaves it
 * either deleted (run died mid-journey) or as an UNCONFIRMED signup
 * leftover, and the journey needs a clean, confirmed starting state.
 */
export async function deleteTestUserIfExists(phone: string): Promise<void> {
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: getUserPoolId(),
      Username: phone,
    }));
  } catch (error) {
    if ((error as Error).name !== 'UserNotFoundException') throw error;
  }
}
