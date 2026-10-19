/**
 * The words of every alarm that exists once, keyed by its construct id.
 * Read the header of alert-copy.ts first: it defines the format and the rules.
 */
import { count, dollars, formatDuration, percent, type AlertCopy } from './alert-copy';

/**
 * One entry per alarm construct id. Alarms created per component (one per
 * lambda, one per table) come from alert-copy-components.ts instead.
 */
export const ALERT_COPY = {
  // ── Document pipeline ────────────────────────────────────────────────
  DdbServiceErrorAlarm: {
    severity: 'medium',
    alarmName: 'the pipeline cannot write to its database',
    symptom: 'Document progress is not being saved',
    impact: 'Parents may see a progress bar that never moves, or an upload that never reports what went wrong.',
    check: [
      'Open the logs for the pipeline database writes function and search for DDB_SERVICE_ERROR to see which write failed.',
      'Check the AWS Health dashboard and the DynamoDB console for a service event or throttling.',
    ],
    runbook: 'documents',
    unit: count('failed database write', 'failed database writes'),
  },
  UnredactedArtifactsRetainedAlarm: {
    severity: 'critical',
    alarmName: 'a failed document kept its unredacted copy',
    symptom: 'Unredacted student information was left in storage after a failed document',
    impact: 'Administrators must act: one family\'s original upload or raw text should have been deleted and was not. Nothing is visible to parents.',
    check: [
      'Run scripts/audit-residue.py (read-only) to list what was left behind.',
      'Remove it with scripts/purge-orphaned-artifacts.py, which does a dry run first.',
    ],
    runbook: 'privacy',
    unit: count('retained copy', 'retained copies'),
    countsFailures: true,
  },
  OcrPurgeFailedAlarm: {
    severity: 'critical',
    alarmName: 'a document kept text we said we would delete',
    symptom: 'Extracted IEP text was not deleted after a summary was made',
    impact: 'Administrators must act: the family\'s summary is fine, but the leftover text should not exist and needs removing.',
    check: [
      'Run scripts/audit-residue.py (read-only) to list the documents that still hold the text.',
      'Remove it with scripts/purge-redacted-ocr.py, which does a dry run first.',
    ],
    runbook: 'privacy',
    unit: count('failed text deletion', 'failed text deletions'),
    countsFailures: true,
  },
  DocumentsFailingAlarm: {
    severity: 'medium',
    alarmName: 'a document failed to process',
    symptom: 'A document failed to process',
    impact: 'The parent who uploaded it sees an error instead of a summary. One unreadable file is common; several in a short time points to a provider outage.',
    check: [
      'Open the logs for the pipeline database writes function and search for RECORD_FAILURE to see which step failed.',
      'If several documents failed, check the status pages for Mistral, OpenAI and AWS Comprehend.',
    ],
    runbook: 'documents',
    unit: count('failed document', 'failed documents'),
    countsFailures: true,
  },
  TranslationSkippedAlarm: {
    severity: 'medium',
    alarmName: 'a family got English only: a requested translation was left out',
    symptom: 'A requested translation was left out of a summary',
    impact: 'One family has the English summary instead of their language. The app offers them "Translate it now", but they may not notice.',
    check: [
      'Open the translation step logs and search for TRANSLATION_SKIPPED to see which language was affected.',
      'If it repeats for one language, test that language with a synthetic document on staging.',
    ],
    runbook: 'documents',
    unit: count('skipped translation', 'skipped translations'),
  },
  PipelineTimedOutAlarm: {
    severity: 'medium',
    alarmName: 'document stuck: pipeline execution timed out',
    symptom: 'A document has been processing for six hours without finishing',
    impact: 'The parent is still on the processing screen and has no error message.',
    check: [
      'Find the timed-out execution in the Step Functions console for the document pipeline and note the step it stopped at.',
      'Mark the document as failed by hand so the parent can retry (see the runbook).',
    ],
    runbook: 'documents',
    unit: count('timed-out run', 'timed-out runs'),
  },
  SweepHeartbeatAlarm: {
    severity: 'medium',
    alarmName: 'pending-upload sweep has stopped running',
    symptom: 'The check for stalled uploads has stopped running',
    impact: 'Parents whose upload stalls will sit on the processing screen with no error.',
    check: [
      'Open the pending-upload sweep schedule in EventBridge and confirm the rule is enabled.',
      'Open the sweep function logs and look for errors on its last runs.',
    ],
    runbook: 'documents',
    unit: {
      render: ({ periodSeconds }) => `the 10-minute sweep did not run in ${formatDuration(periodSeconds)}`,
    },
  },
  SweepFailingAlarm: {
    severity: 'medium',
    alarmName: 'pending-upload sweep failing to invoke',
    symptom: 'The check for stalled uploads cannot start',
    impact: 'Parents whose upload stalls will sit on the processing screen with no error.',
    check: [
      'Open the pending-upload sweep schedule in EventBridge and look at its failed invocations.',
      'Check that the sweep function exists and its permissions have not changed since the last deploy.',
    ],
    runbook: 'documents',
    unit: count('failed start', 'failed starts'),
  },
  TranslationRunsFailingAlarm: {
    severity: 'medium',
    alarmName: 'on-demand translations are failing',
    symptom: '"Translate it now" requests are failing',
    impact: 'Parents who ask for a translation wait on a page and nothing arrives.',
    check: [
      'Open the on-demand translation state machine in Step Functions and read the error on the failed runs.',
      'Check the AWS Translate service health.',
    ],
    runbook: 'documents',
    unit: count('failed translation', 'failed translations'),
  },

  // ── App and API ──────────────────────────────────────────────────────
  ApiServerErrorAlarm: {
    severity: 'critical',
    alarmName: 'API returning 5xx',
    symptom: 'The app is returning server errors',
    impact: 'Parents cannot load summaries, save a profile or start an upload.',
    check: [
      'Open the API Gateway access logs and find which route is failing.',
      'Open that route\'s function logs, or check for a recent deploy that could have caused it.',
    ],
    runbook: 'api',
    unit: count('server error', 'server errors'),
    recovery: 'The app has stopped returning server errors',
  },

  // ── Sign-in ──────────────────────────────────────────────────────────
  AuthStartRefusedAlarm: {
    severity: 'medium',
    alarmName: 'sign-ins are being refused in bulk',
    symptom: 'Many sign-in attempts are being turned away',
    impact: 'Either someone is attacking sign-in and our limits are holding, or the limits are too tight and real parents are locked out.',
    check: [
      'Open the sign-in start logs and search for AUTH_START_REFUSED to see the reason and whether the requests come from one source.',
      'Ask a parent or test a sign-in yourself to rule out real users being blocked.',
    ],
    runbook: 'abuse',
    unit: count('refused sign-in', 'refused sign-ins'),
  },
  AuthCodeNotSentAlarm: {
    severity: 'critical',
    alarmName: 'login codes are not being sent',
    symptom: 'Sign-in codes are not being sent',
    impact: 'Parents ask for a sign-in code, none arrives, and they cannot get into the app.',
    check: [
      'Open the sign-in code sender logs and search for AUTH_DISPATCH_FAILED to see the reason.',
      'Check the SMS and email providers for an incident, and the SMS spend against its monthly cap.',
    ],
    runbook: 'signInCodes',
    unit: count('failed code send', 'failed code sends'),
    recovery: 'Sign-in codes are being sent again',
  },
  AuthVerifyCounterDegradedAlarm: {
    severity: 'medium',
    alarmName: 'the wrong-code limit is not being enforced',
    symptom: 'The limit on wrong sign-in codes is switched off',
    impact: 'Parents can still sign in. Repeated wrong guesses are limited only by Cognito\'s own three tries per code.',
    check: [
      'Open the sign-in verify logs and search for AUTH_VERIFY_COUNTER_UNAVAILABLE.',
      'Check the login rate limiting table for throttling or access errors.',
    ],
    runbook: 'signInFailing',
    unit: count('missed check', 'missed checks'),
  },
  SmsDestinationRefusedAlarm: {
    severity: 'medium',
    alarmName: 'login codes being requested for numbers we do not serve',
    symptom: 'Sign-in codes are being requested for phone numbers outside our countries',
    impact: 'No money is spent and no parent is affected. This is what an SMS abuse run looks like when it starts.',
    check: [
      'Open the sign-in code creation logs and search for SMS_REFUSED_DESTINATION to see the country prefixes.',
      'Watch the SMS spend and the "signup flood" alert over the next hour.',
    ],
    runbook: 'abuse',
    unit: count('refused phone number', 'refused phone numbers'),
  },
  SmsBudgetExhaustedAlarm: {
    severity: 'critical',
    alarmName: 'login codes are being refused: the sending limit is reached',
    symptom: 'Sign-in codes are refused because the sending limit was reached',
    impact: 'Parents are turned away at sign-in. The service-wide limit on texted codes has been used up.',
    check: [
      'Open the sign-in code creation logs and search for SMS_BUDGET_EXHAUSTED to see how fast the limit was used.',
      'Decide whether this is abuse (see the runbook) or real demand before changing any limit.',
    ],
    runbook: 'smsSpend',
    unit: count('refused code', 'refused codes'),
    countsFailures: true,
  },
  SmsSendFailedAlarm: {
    severity: 'critical',
    alarmName: 'login codes are not being delivered',
    symptom: 'Texting a sign-in code is failing',
    impact: 'Parents who sign in by phone get no code and cannot get in.',
    check: [
      'Open the sign-in code creation logs and search for SMS_SEND_FAILED to see the error.',
      'Check AWS SNS for an incident and confirm the SMS spend is under its monthly cap.',
    ],
    runbook: 'signInCodes',
    unit: count('failed text', 'failed texts'),
    countsFailures: true,
  },
  SmsNotificationsFailedAlarm: {
    severity: 'critical',
    alarmName: 'the SMS provider is rejecting login codes',
    symptom: 'The SMS provider is rejecting sign-in codes',
    impact: 'Parents who sign in by phone are told a code is coming and none arrives, in both prod and staging. Often this is the monthly spend cap.',
    check: [
      'Check the SMS spend against the monthly cap in the SNS console.',
      'Open the SNS delivery failure log group and read the provider response on the latest failures.',
    ],
    runbook: 'smsSpend',
    unit: count('rejected text', 'rejected texts'),
    countsFailures: true,
    accountWide: true,
  },
  SmsQuotaExhaustedAlarm: {
    severity: 'critical',
    alarmName: 'the monthly SMS cap is reached and login codes are being binned',
    symptom: 'The monthly SMS spending cap has been reached',
    impact: 'No parent in either environment can receive a sign-in code by text until the limit is raised or the month rolls over.',
    check: [
      'Check for signup abuse first (see the runbook), because raising the cap during an attack pays for the attack.',
      'If the traffic is real, raise the SNS monthly spend limit and update SMS_MONTHLY_LIMIT_USD in monitoring.ts.',
    ],
    runbook: 'smsSpend',
    unit: count('dropped text', 'dropped texts'),
    countsFailures: true,
    accountWide: true,
  },
  SmsDeliveryFailedAlarm: {
    severity: 'medium',
    alarmName: 'login codes are being accepted and then not delivered',
    symptom: 'Several sign-in codes were accepted by the provider and never delivered',
    impact: 'Those parents got no code. A few a day is normal (landlines, dead phones); this is more.',
    check: [
      'Check whether the failures are all for one country or carrier in the SNS delivery failure log group.',
      'If they are spread out, check the SNS service health.',
    ],
    runbook: 'signInCodes',
    unit: count('undelivered code', 'undelivered codes'),
    countsFailures: true,
  },
  SmsFailureClassifierFailingAlarm: {
    severity: 'medium',
    alarmName: 'undelivered login codes are not being counted',
    symptom: 'The counter for undelivered sign-in codes is broken',
    impact: 'No one yet. The alert for undelivered codes cannot fire until this is fixed.',
    check: [
      'Open the SMS failure classifier logs and read the latest error.',
      'Check that its permissions and the log subscription were not changed by a recent deploy.',
    ],
    runbook: 'signInCodes',
    unit: count('classifier error', 'classifier errors'),
  },
  SmsSpendVelocityAlarm: {
    severity: 'critical',
    alarmName: 'SMS spend is climbing fast: an abuse run may be under way',
    symptom: 'SMS spending is climbing unusually fast',
    impact: 'No one yet. If it continues, the monthly cap is hit and no parent can receive a sign-in code.',
    check: [
      'Open the sign-in code creation logs and look at the destinations and signup volume for the last hour.',
      'If it is abuse, tighten the signup limits before the cap is reached (see the runbook).',
    ],
    runbook: 'smsSpend',
    unit: {
      render: ({ threshold }) => `SMS spend above ${dollars(threshold)} an hour`,
    },
    recovery: 'SMS spending is back to a normal rate',
    accountWide: true,
  },
  SignupSurgeAlarm: {
    severity: 'critical',
    alarmName: 'signup flood: someone is abusing the signup form',
    symptom: 'A flood of new accounts is being created',
    impact: 'No one yet. Each account sends a text, so this burns the monthly SMS budget and can leave parents without sign-in codes.',
    check: [
      'Open the signup logs and look at the phone prefixes and timing of the new accounts.',
      'Confirm the bot check is on, then follow the abuse steps in the runbook.',
    ],
    runbook: 'abuse',
    unit: count('signup on a real number or address', 'signups on real numbers or addresses'),
    recovery: 'Account creation is back to a normal rate',
  },
  SignupVolumeBackstopAlarm: {
    severity: 'medium',
    alarmName: 'signup volume far above normal, test accounts included',
    symptom: 'Far more signups than normal, most on test numbers',
    impact: 'No one yet. Test numbers cannot receive texts, so nothing is spent, but the account list is filling up.',
    check: [
      'Open the signup logs and compare SIGNUP_ATTEMPT destination=fictional with destination=reachable.',
      'If no test run was going on, follow the abuse steps in the runbook.',
    ],
    runbook: 'abuse',
    unit: count('signup attempt', 'signup attempts'),
    recovery: 'Signup volume is back to normal',
  },
  EmailSuppressionCheckUnavailableAlarm: {
    severity: 'critical',
    alarmName: 'email sign-in is refusing everyone: the do-not-email check is down',
    symptom: 'Email sign-in is refusing everyone',
    impact: 'Parents who sign in by email get no code, because the do-not-email list cannot be read.',
    check: [
      'Open the sign-in code creation logs and search for EMAIL_SUPPRESSION_UNAVAILABLE.',
      'Check the email suppression table for throttling or a permissions change.',
    ],
    runbook: 'signInCodes',
    unit: count('failed list check', 'failed list checks'),
    countsFailures: true,
  },
  EmailSuppressedDestinationAlarm: {
    severity: 'medium',
    alarmName: 'login codes being requested for addresses we may not email',
    symptom: 'Sign-in codes are being requested for addresses that bounced before',
    impact: 'No one is affected, because no email is sent to them. This is what an attacker replaying old addresses looks like.',
    check: [
      'Open the sign-in code creation logs and search for EMAIL_SUPPRESSED_DESTINATION.',
      'Look for one source repeating many addresses.',
    ],
    runbook: 'abuse',
    unit: count('refused address', 'refused addresses'),
  },
  EmailBudgetExhaustedAlarm: {
    severity: 'critical',
    alarmName: 'email login codes are being refused: the sending limit is reached',
    symptom: 'Email sign-in codes are refused because the sending limit was reached',
    impact: 'Parents who sign in by email are turned away. The service-wide limit on emailed codes has been used up.',
    check: [
      'Open the sign-in code creation logs and search for EMAIL_BUDGET_EXHAUSTED to see how fast it was used.',
      'Decide whether this is abuse (see the runbook) or real demand.',
    ],
    runbook: 'signInCodes',
    unit: count('refused email', 'refused emails'),
    countsFailures: true,
  },
  EmailSendFailedAlarm: {
    severity: 'critical',
    alarmName: 'email login codes are not being delivered',
    symptom: 'Emailing a sign-in code is failing',
    impact: 'Parents who sign in by email get no code and cannot get in.',
    check: [
      'Open the sign-in code creation logs and search for EMAIL_SEND_FAILED to see the error.',
      'Check the SES console for a sending pause, and the AWS Health dashboard.',
    ],
    runbook: 'signInCodes',
    unit: count('failed email', 'failed emails'),
    countsFailures: true,
  },

  // ── Sign-up ──────────────────────────────────────────────────────────
  SignupPasswordNotRotatedAlarm: {
    severity: 'critical',
    alarmName: 'new accounts may be reachable by whoever created them',
    symptom: 'A new account could not be secured',
    impact: 'Administrators must act: an account was created but could not be locked down, and removing it also failed. Treat accounts created now as untrusted until it is cleared.',
    check: [
      'Open the auth send function logs and search for SIGNUP_ORPHANED to find the account.',
      'Disable or delete that account in Cognito, then find out why the cleanup failed (see the runbook).',
    ],
    runbook: 'signup',
    unit: count('unsecured account', 'unsecured accounts'),
    countsFailures: true,
  },
  TurnstileNotConfiguredAlarm: {
    severity: 'medium',
    alarmName: 'the signup bot check is switched off',
    symptom: 'The sign-up bot check is switched off',
    impact: 'Sign-ups still work, but the defence against scripts is missing. The rate limits still apply.',
    check: [
      'Check that the Turnstile secret parameter exists for this environment in Parameter Store.',
      'If it is missing, create it (see the runbook).',
    ],
    runbook: 'signup',
    unit: count('unchecked sign-up', 'unchecked sign-ups'),
  },

  // ── Privacy ──────────────────────────────────────────────────────────
  DeletionIncompleteAlarm: {
    severity: 'critical',
    alarmName: 'a parent asked us to delete their records and we did not',
    symptom: 'A deletion request was only partly carried out',
    impact: 'Administrators must act: a parent asked for a child\'s documents or profile to be removed, and some of it still exists.',
    check: [
      'Open the user profile function logs and search for DELETION_INCOMPLETE to find the user and step.',
      'Remove what is left by hand and confirm it is gone before telling the parent (see the runbook).',
    ],
    runbook: 'privacy',
    unit: count('incomplete deletion', 'incomplete deletions'),
    countsFailures: true,
  },

  // ── Usage ────────────────────────────────────────────────────────────
  KmsCallVolumeAlarm: {
    severity: 'low',
    alarmName: 'unusual AWS API volume',
    symptom: 'Something is making unusually many calls to AWS',
    impact: 'No one. It is usually a script or an automated agent left running.',
    check: [
      'Look in CloudTrail for the identity making the most KMS calls in the last hour.',
      'Stop it if it is a script or agent you recognise.',
    ],
    runbook: 'awsUsage',
    unit: count('encryption call', 'encryption calls'),
    accountWide: true,
  },

  // ── The alerting path itself ─────────────────────────────────────────
  AlertFormatterFailingAlarm: {
    severity: 'critical',
    alarmName: 'alerting itself is broken',
    symptom: 'Alerts are not being formatted, so Slack may look quiet',
    impact: 'Administrators may miss real problems. Alarms still fire in CloudWatch, but their Slack messages are failing.',
    check: [
      'Open the CloudWatch alarms page and look for any alarms in the ALARM state.',
      'Open the alert formatter logs and read the latest error.',
    ],
    runbook: 'alerting',
    unit: count('formatter error', 'formatter errors'),
    recovery: 'Alerts are being formatted again',
  },
  AlertDeliveryFailingAlarm: {
    severity: 'critical',
    alarmName: 'alerts are not reaching the formatter',
    symptom: 'Alerts are not being delivered, so Slack may look quiet',
    impact: 'Administrators may miss real problems. Alarms fire in CloudWatch but never reach Slack.',
    check: [
      'Open the CloudWatch alarms page and look for any alarms in the ALARM state.',
      'Check that the alarm topic still has its subscription to the alert formatter function.',
    ],
    runbook: 'alerting',
    unit: count('failed delivery', 'failed deliveries'),
    recovery: 'Alerts are being delivered again',
  },
  DailyBriefMissingAlarm: {
    severity: 'low',
    alarmName: 'the daily health brief has stopped running',
    symptom: 'The daily health summary did not go out',
    impact: 'No one is affected, but a quiet channel no longer means everything is fine.',
    check: [
      'Open the daily brief schedule in EventBridge and confirm the rule is enabled.',
      'Open the daily brief function logs and look for errors.',
    ],
    runbook: 'alerting',
    unit: {
      render: ({ periodSeconds, evaluationPeriods }) =>
        `no daily summary sent in ${formatDuration(periodSeconds * evaluationPeriods)}`,
    },
  },
  DailyBriefFailingAlarm: {
    severity: 'medium',
    alarmName: 'the daily health brief is failing',
    symptom: 'The daily health summary failed to send',
    impact: 'No one is affected, but a quiet channel no longer means everything is fine.',
    check: [
      'Open the daily brief function logs and read the latest error.',
      'Check that it can still publish to the alert topic.',
    ],
    runbook: 'alerting',
    unit: count('failed summary', 'failed summaries'),
  },

  // ── Email reputation ─────────────────────────────────────────────────
  EmailBounceRateReviewAlarm: {
    severity: 'medium',
    alarmName: 'email bounce rate is climbing',
    symptom: 'Many sign-in emails are bouncing',
    impact: 'No one yet. At 5% AWS puts the account under review; this fires at 2%, while there is room to act.',
    check: [
      'Open the SES console reputation page and see which messages bounced.',
      'Check the do-not-email list is being updated, and look for abuse (see the runbook).',
    ],
    runbook: 'email',
    unit: { render: ({ threshold }) => `a bounce rate of ${percent(threshold)}% or more` },
    accountWide: true,
  },
  EmailBounceRateCriticalAlarm: {
    severity: 'critical',
    alarmName: 'email bounce rate near the limit AWS suspends accounts over',
    symptom: 'The email bounce rate is close to the suspension limit',
    impact: 'If AWS suspends email sending, no parent can sign in by email, and getting it back means an appeal to AWS.',
    check: [
      'Open the SES console reputation page and see which messages bounced.',
      'Pause or tighten email sign-in if the cause is abuse (see the runbook), and open an AWS Support case early.',
    ],
    runbook: 'email',
    unit: { render: ({ threshold }) => `a bounce rate of ${percent(threshold)}% or more` },
    recovery: 'The email bounce rate has dropped',
    accountWide: true,
  },
  EmailComplaintRateReviewAlarm: {
    severity: 'medium',
    alarmName: 'email complaint rate is climbing',
    symptom: 'People are marking sign-in emails as spam',
    impact: 'No one yet. Someone is receiving codes they did not ask for. At 0.1% AWS puts the account under review.',
    check: [
      'Open the SES console reputation page and see the complaint rate.',
      'Look for abuse sending codes to addresses that did not ask for them (see the runbook).',
    ],
    runbook: 'email',
    unit: { render: ({ threshold }) => `a spam complaint rate of ${percent(threshold)}% or more` },
    accountWide: true,
  },
  EmailComplaintRateCriticalAlarm: {
    severity: 'critical',
    alarmName: 'email complaint rate near the limit AWS suspends accounts over',
    symptom: 'The spam complaint rate is close to the suspension limit',
    impact: 'If AWS suspends email sending, no parent can sign in by email, and getting it back means an appeal to AWS.',
    check: [
      'Open the SES console reputation page and see the complaint rate.',
      'Stop the source of the complaints (see the runbook) and open an AWS Support case early.',
    ],
    runbook: 'email',
    unit: { render: ({ threshold }) => `a spam complaint rate of ${percent(threshold)}% or more` },
    recovery: 'The spam complaint rate has dropped',
    accountWide: true,
  },
  EmailBounceBurstAlarm: {
    severity: 'critical',
    alarmName: 'login codes are being emailed to addresses that do not exist',
    symptom: 'Sign-in codes are being emailed to addresses that do not exist',
    impact: 'No parent is affected yet. This is what someone feeding invented addresses to the sign-in form looks like, and it ends in AWS suspending email.',
    check: [
      'Open the SES console and look at the bounced addresses for a pattern.',
      'Follow the abuse steps in the runbook to slow the source.',
    ],
    runbook: 'email',
    unit: count('bounced email', 'bounced emails'),
    countsFailures: true,
  },
  EmailComplaintAlarm: {
    severity: 'medium',
    alarmName: 'someone marked an A-IEP login code as spam',
    symptom: 'Someone marked a sign-in email as spam',
    impact: 'No one is locked out. A code reached someone who did not ask for it. AWS allows about one complaint per thousand emails.',
    check: [
      'Open the SES console and see the complaint details.',
      'Check whether that address was entered on the sign-in form by someone else.',
    ],
    runbook: 'email',
    unit: count('spam complaint', 'spam complaints'),
    countsFailures: true,
  },
  EmailRejectAlarm: {
    severity: 'medium',
    alarmName: 'AWS is refusing to send A-IEP login emails',
    symptom: 'AWS is refusing to send some sign-in emails',
    impact: 'Those parents get no code. Sign-in emails should never be rejected, so this is about what is being sent.',
    check: [
      'Open the SES console and read the reject reason.',
      'Check the email content and the sending identity have not changed.',
    ],
    runbook: 'email',
    unit: count('rejected email', 'rejected emails'),
    countsFailures: true,
  },
  EmailDeliveryDelayAlarm: {
    severity: 'low',
    alarmName: 'email login codes are arriving late',
    symptom: 'Sign-in emails are being delivered late',
    impact: 'Parents wait on an empty inbox and may ask for another code. The code usually still arrives.',
    check: [
      'Open the SES console and see which receiving providers are delaying delivery.',
      'No action is needed unless it continues for hours.',
    ],
    runbook: 'email',
    unit: count('delayed email', 'delayed emails'),
    countsFailures: true,
  },
  SesSuppressionWriteFailedAlarm: {
    severity: 'medium',
    alarmName: 'a bounced or complained address was not recorded',
    symptom: 'A bounced address could not be added to the do-not-email list',
    impact: 'No parent is affected yet. That address will be emailed again, which is how an email suspension starts.',
    check: [
      'Open the bounce handler logs and search for SES_SUPPRESSION_WRITE_FAILED.',
      'Check the suppression table for throttling or a permissions change.',
    ],
    runbook: 'email',
    unit: count('unrecorded address', 'unrecorded addresses'),
  },
  SesBounceHandlerErrorAlarm: {
    severity: 'medium',
    alarmName: 'the do-not-email list is not being maintained',
    symptom: 'The do-not-email list is not being updated',
    impact: 'No parent is affected yet. Addresses that bounced or complained will be emailed again, and the account is heading for an AWS review.',
    check: [
      'Open the bounce handler logs and read the latest error.',
      'Check that the handler is still subscribed to the SES event topic.',
    ],
    runbook: 'email',
    unit: count('handler error', 'handler errors'),
  },
} as const satisfies Record<string, AlertCopy>;

export type StaticAlarmId = keyof typeof ALERT_COPY;
