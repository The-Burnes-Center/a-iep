/**
 * AWS-side helpers: the OTP backdoor reader and the Cognito test-user
 * lifecycle. Everything here is admin-plane; the specs drive the actual
 * product through the browser only.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomBytes } from 'crypto';
import { REGION, TEST_OTP_PARAM_PREFIX, getUserPoolId } from './config';

const ssm = new SSMClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

/**
 * Two writers stash codes at the same parameter, with slightly different
 * payloads: create-auth-challenge (our sign-in OTP) records the language it
 * would have localized the SMS with, while the CustomSMSSender trigger
 * (Cognito's own verification codes) records which trigger source produced it.
 * Only `code` and `issuedAt` are common to both.
 *
 * Since the PreSignUp auto-confirm landed, the two fields are how a spec tells
 * a LOGIN code from a Cognito-minted one, and phone signup must produce only
 * the former: `source` appearing on a signup is the two-text regression.
 */
export interface OtpPayload {
  code: string;
  issuedAt: string;
  /** Present on sign-in OTPs from create-auth-challenge. */
  language?: string;
  /** `cognito-<triggerSource>`, present on CustomSMSSender stashes. */
  source?: string;
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
 * How many codes have EVER been issued to `phone`, as SSM's own tally.
 *
 * Both writers PutParameter(Overwrite) on every send, and SSM bumps the
 * parameter's Version on every write (the payload always differs anyway: fresh
 * issuedAt, random code), so the version IS a running total of codes sent to
 * this number. Reading it either side of a flow is the only way to assert HOW
 * MANY texts a parent received: each write overwrites the last, so a second
 * code leaves no trace in the parameter's value.
 *
 * 0 when the parameter does not exist yet (no code ever issued for `phone`).
 */
export async function readOtpSendCount(phone: string): Promise<number> {
  const name = otpParameterName(phone);
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    const version = result.Parameter?.Version;
    if (typeof version !== 'number') {
      // Never silently 0: a missing version would make a "how many codes"
      // assertion pass by accident, which is worse than failing here.
      throw new Error(`SSM returned ${name} without a Version, so its send count is unknowable`);
    }
    return version;
  } catch (error) {
    if ((error as Error).name === 'ParameterNotFound') return 0;
    throw error;
  }
}

/** The admin-plane facts about a test account that the browser cannot see. */
export interface TestUserState {
  /** Cognito's UserStatus, e.g. CONFIRMED or UNCONFIRMED. */
  status: string;
  /** The phone_number_verified attribute. */
  isPhoneVerified: boolean;
}

/**
 * Read `phone`'s account state.
 *
 * The single-SMS signup contract rests on the PreSignUp trigger setting BOTH
 * autoConfirmUser and autoVerifyPhone, and neither is visible from the
 * browser: the sign-up confirmation screen and the login OTP screen are the
 * same screen with the same copy. UNCONFIRMED after a signup means Cognito is
 * still waiting for a verification code, i.e. the parent is owed a second text.
 */
export async function readTestUserState(phone: string): Promise<TestUserState> {
  const result = await cognito.send(new AdminGetUserCommand({
    UserPoolId: getUserPoolId(),
    Username: phone,
  }));
  const phoneVerified = result.UserAttributes
    ?.find((attribute) => attribute.Name === 'phone_number_verified')?.Value;

  return {
    status: result.UserStatus ?? '(no UserStatus returned)',
    isPhoneVerified: phoneVerified === 'true',
  };
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
 *
 * Untouched by the two triggers that now reshape self-service signup:
 * AdminCreateUser fires PreSignUp_AdminCreateUser, which pre-sign-up.js
 * explicitly excludes, and it fires no PostConfirmation trigger at all, so the
 * phone-only password rotation in user-profile-handler/cognito_trigger.py
 * (gated on PostConfirmation_ConfirmSignUp) never runs for these users. It
 * would not matter if it did: nothing in this suite ever signs in with a
 * password, and the permanent-password call exists only to reach CONFIRMED.
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
