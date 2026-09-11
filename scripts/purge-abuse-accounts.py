#!/usr/bin/env python3
"""
Remove the Cognito accounts created by the 2026-09-09 SMS-pumping run, and the
user-profile rows they left behind.

The run created roughly a thousand accounts in about a quarter of an hour by
calling Cognito's public SignUp API directly. None of them were ever usable:
the PostConfirmation trigger rotates a phone-only account's client-chosen
password away (cognito_trigger.py::_neutralize_client_chosen_password), so the
only way in was an OTP texted to a handset the caller did not own. What they
are is clutter: they are 78% of the production pool, so every user count, every
"how many families do we serve" answer and every future audit is wrong until
they are gone.

## Nothing here may ever delete a real family's account

That is the whole design constraint, so the criteria are stated out loud and
the script prints them on every run, dry or not. An account is a candidate only
if EVERY condition holds, and any single guard tripping removes it from the set
and prints it for review:

  CANDIDATE
    1. created inside the burst window, which is DERIVED from the pool at
       runtime (see detect_burst_window) and must fall inside the incident day
       below, not assumed from it
    2. carries a phone_number whose country code is NOT +1

  GUARDS, any one of which spares the account
    G1  phone_number is +1, or missing entirely. A-IEP serves families in the
        United States; SMS_ALLOWED_COUNTRY_CODES in lib/authorization/new-auth.ts
        is ['+1'], so every real user is +1 and no real user is anything else.
    G2  phone_number is a reserved test number: the E2E allowlist parsed out of
        new-auth.ts, the permanent smoke users (+15555550101 staging,
        +15555550102 production), the unknown-number probe scripts/smoke-test.sh
        claims, and as a blanket, the whole NANP fictional +1 555 555-01XX
        block, allocated or not.
    G3  the account owns an IEP document (byUserId GSI on the documents table).
    G4  the account shows any sign of having used the app. See has_app_activity:
        its profile row differs in any way from the row PostConfirmation writes
        unattended. A REAL PROXY AND NOT A PROOF, and the honest reason is that
        this pool has AdvancedSecurityMode off, so AdminListUserAuthEvents
        returns UserPoolAddOnNotEnabledException and Cognito will not tell us
        who has signed in. What it does establish is that nothing authenticated
        ever wrote to that profile: no consent, no onboarding, no language
        choice, no renamed child, no document. An account with NO profile row
        at all is also guarded, because absence proves nothing either way.
    G5  the account owns or was the target of a referral row.

The guards are deliberately redundant. G1 alone already spares every reserved
test number, and on production every non-+1 account was created on the incident
day. Redundancy is the point: one criterion being wrong should not be enough.

Anything matching EITHER candidate criterion on the incident day is reviewed and
printed, not just the accounts that match both. That is what surfaces the one +1
account created in the middle of the burst, and the non-+1 accounts that fall
just outside it, which are the rows a human should look at before a thousand
deletes run.

## Orphaned profile rows

Profile rows are keyed on userId alone (the Cognito sub) in the table read by
user-profile-handler/lambda_function.py. A row whose sub is in no user pool can
never be read or deleted by anyone: account deletion works from the token
inward, so a row that outlives its account outlives every path that could
remove it. Those are reported and purged separately from the abuse set, and
they are NOT abuse: on production they are ordinary families whose accounts are
gone, so what is left is retained PII.

Usage (dry run is the default; nothing is deleted without --apply):
    scripts/purge-abuse-accounts.py --environment prod
    scripts/purge-abuse-accounts.py --environment staging
    scripts/purge-abuse-accounts.py --environment prod --apply
    scripts/purge-abuse-accounts.py --environment prod --limit 5 --apply
    scripts/purge-abuse-accounts.py --environment prod --orphan-profiles --apply

--environment is required and has no default, so nobody points a delete at the
wrong account by leaving a flag off.

Recoverability: none. Cognito cannot export or re-import a credential, so a
deleted account is gone. That is why every ceiling below aborts instead of
truncating.

PII discipline: phone numbers are masked to country code plus last three
(+44******123) and only ten are ever printed. Usernames appear as a short sub
prefix. No names, no document content, no full identifiers.
"""
import argparse
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = 'us-east-1'

STACK_PREFIX = {'staging': 'AIEPStagingStack', 'prod': 'AIEPStack'}

# The incident. The burst window is measured from the pool, but it must land
# inside this day or the script refuses to run: a derived window that wandered
# onto a different date would be deleting something other than this incident.
INCIDENT_DAY = datetime(2026, 9, 9, tzinfo=timezone.utc)

# Burst detection. A minute holding at least this many signups is not organic
# for a service whose busiest ordinary day in the pool's entire history is 55
# accounts. Busy minutes within BURST_GAP_MINUTES of each other are one burst:
# the 2026-09-09 run paused for six minutes in the middle and is still one run.
BURST_ACCOUNTS_PER_MINUTE = 10
BURST_GAP_MINUTES = 10
# Ceilings that abort rather than truncate. The run lasted ~14 minutes and
# created ~1030 accounts; anything materially larger means the detection is
# wrong, not that the incident was bigger than remembered.
MAX_WINDOW_MINUTES = 60
MAX_CANDIDATES = 1200

ALLOWED_COUNTRY_CODE = '+1'

# NANP fictional block, the one +1 555 555-01XX range that can never reach a
# real handset. Guarded wholesale rather than by list, so a test number
# allocated after this script was written is still safe.
FICTIONAL_BLOCK = re.compile(r'^\+155555501\d{2}$')

# Permanent smoke users (created 2026-07-27) and the guaranteed-unknown-number
# probe in scripts/smoke-test.sh. Deliberately absent from the E2E allowlist in
# new-auth.ts, so parsing that file does not find them.
RESERVED_NUMBERS = {
    '+15555550101',  # staging smoke user
    '+15555550102',  # production smoke user
    '+15555550123',  # smoke-test.sh unknown-number probe; must never gain a user
}

# The profile row PostConfirmation writes unattended (cognito_trigger.py). An
# account whose row is exactly this has never had anything authenticated write
# to it. Note the absence of createdAtISO / updatedAtISO: the authenticated
# get_user_profile path always writes those, so their presence alone is
# evidence of a real session.
DEFAULT_PROFILE_KEYS = {
    'userId', 'createdAt', 'updatedAt', 'children', 'consentGiven', 'showOnboarding',
}
DEFAULT_CHILD_KEYS = {'childId', 'name', 'schoolCity', 'createdAt', 'updatedAt'}
DEFAULT_CHILD_NAME = 'My Child'
DEFAULT_CHILD_CITY = 'Not specified'

SAMPLE_SIZE = 10
# The guarded list is meant to be read line by line, so it is capped rather
# than allowed to bury the counts under a thousand rows.
GUARDED_PRINT_LIMIT = 50

cognito = boto3.client('cognito-idp', region_name=REGION)
cloudformation = boto3.client('cloudformation', region_name=REGION)
dynamodb = boto3.resource('dynamodb', region_name=REGION)
ssm = boto3.client('ssm', region_name=REGION)


def find_one(names, *must_contain, forbid=()):
    """Resolve exactly one AWS resource name, or fail loudly."""
    matches = [
        n for n in names
        if all(frag in n for frag in must_contain)
        and not any(bad in n for bad in forbid)
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"expected exactly one resource matching {must_contain} "
            f"(excluding {forbid}), found {len(matches)}: {matches}"
        )
    return matches[0]


def discover(environment):
    prefix = STACK_PREFIX[environment]
    # Prod names must not contain 'staging', or a prod run could delete staging
    # accounts (and, far worse, judge prod accounts against staging's rows).
    forbid = () if environment == 'staging' else ('Staging', 'staging')

    table_names = []
    for page in dynamodb.meta.client.get_paginator('list_tables').paginate():
        table_names.extend(page['TableNames'])

    # The pool id comes from the stack's own output, never from a pool name: a
    # display name is editable in the console and two pools could share one.
    outputs = cloudformation.describe_stacks(StackName=prefix)['Stacks'][0].get('Outputs', [])
    by_key = {o['OutputKey']: o['OutputValue'] for o in outputs}
    pool_key = find_one(list(by_key), 'NewUserPoolID', forbid=forbid)

    return {
        'user_pool_id': by_key[pool_key],
        'profiles_table': find_one(table_names, prefix, 'UserProfilesTable', forbid=forbid),
        'documents_table': find_one(table_names, prefix, 'IepDocumentsTable', forbid=forbid),
        'referrals_table': find_one(table_names, prefix, 'ReferralsTable', forbid=forbid),
    }


def reserved_numbers(environment):
    """
    Every phone number a test or a smoke check may own.

    The E2E allowlist is parsed out of lib/authorization/new-auth.ts rather than
    copied here, so it cannot drift from the list CDK actually deploys. Failing
    to find it is fatal: a silently empty allowlist is a missing guard.
    """
    numbers = set(RESERVED_NUMBERS)

    source = Path(__file__).resolve().parent.parent / 'lib' / 'authorization' / 'new-auth.ts'
    text = source.read_text(encoding='utf-8')
    match = re.search(r'const TEST_PHONE_NUMBERS\s*=\s*\[(.*?)\]', text, re.DOTALL)
    if not match:
        raise SystemExit(f'could not read TEST_PHONE_NUMBERS out of {source}; refusing to '
                         'run without the test-number guard')
    parsed = set(re.findall(r"'(\+\d+)'", match.group(1)))
    if not parsed:
        raise SystemExit(f'TEST_PHONE_NUMBERS in {source} parsed as empty; refusing to run')
    numbers |= parsed

    # Best effort: the smoke user's number is also in SSM, and reading it means
    # a number rotated out of band is still guarded.
    try:
        value = ssm.get_parameter(Name=f'/a-iep/{environment}/smoke-test-phone')['Parameter']['Value']
        if value:
            numbers.add(value.strip())
    except ClientError:
        pass

    return numbers


def mask_phone(number):
    """Country code plus last three, e.g. +44******123."""
    if not number:
        return '(no phone)'
    if len(number) <= 6:
        return '*' * len(number)
    return number[:3] + '*' * (len(number) - 6) + number[-3:]


def list_pool_users(user_pool_id):
    """Every user in the pool, flattened to the fields the criteria need."""
    users, kwargs = [], {'UserPoolId': user_pool_id, 'Limit': 60}
    while True:
        page = cognito.list_users(**kwargs)
        for user in page['Users']:
            attributes = {a['Name']: a['Value'] for a in user.get('Attributes', [])}
            users.append({
                'username': user['Username'],
                'sub': attributes.get('sub'),
                'phone': attributes.get('phone_number', ''),
                'email': attributes.get('email', ''),
                'status': user.get('UserStatus'),
                'enabled': user.get('Enabled'),
                'created': user['UserCreateDate'].astimezone(timezone.utc),
                'modified': user['UserLastModifiedDate'].astimezone(timezone.utc),
            })
        token = page.get('PaginationToken')
        if not token:
            return users
        kwargs['PaginationToken'] = token


def scan(table_name, **extra):
    table = dynamodb.Table(table_name)
    items, kwargs = [], dict(extra)
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get('Items', []))
        if 'LastEvaluatedKey' not in page:
            return items
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']


def find_bursts(users):
    """
    Every signup burst in the pool's history, by density rather than by a
    remembered timestamp. Returns [(start, end, count)] oldest first.

    Buckets creations into UTC minutes, keeps the minutes holding at least
    BURST_ACCOUNTS_PER_MINUTE accounts, and joins ones within BURST_GAP_MINUTES
    into a single burst.

    All of them are returned, not just the incident, because a pool can hold
    more than one: production also has a 2025-09-20 cluster of ~50 signups in
    eleven minutes, which is a room full of people at an event, not an attack.
    Reporting both is what lets a reader tell them apart instead of trusting
    that the script picked correctly.

    Deriving the window matters. The sparse singleton signups either side of
    the 2026-09-09 burst are ordinary people who happened to sign up that
    evening, and a window stretched to the whole day would sweep them in.
    """
    per_minute = {}
    for user in users:
        minute = user['created'].replace(second=0, microsecond=0)
        per_minute[minute] = per_minute.get(minute, 0) + 1

    busy = sorted(m for m, count in per_minute.items() if count >= BURST_ACCOUNTS_PER_MINUTE)
    bursts = []
    for minute in busy:
        if bursts and minute - bursts[-1][-1] <= timedelta(minutes=BURST_GAP_MINUTES):
            bursts[-1].append(minute)
        else:
            bursts.append([minute])

    return [
        (group[0], group[-1] + timedelta(minutes=1),
         sum(1 for u in users if group[0] <= u['created'] < group[-1] + timedelta(minutes=1)))
        for group in bursts
    ]


def incident_window(bursts):
    """
    The one burst that belongs to INCIDENT_DAY, or None.

    Two on the same day is ambiguous and aborts rather than guessing: this
    script is written for one event, and picking between two without a human
    looking is exactly the shortcut that deletes the wrong thing.
    """
    same_day = [b for b in bursts if INCIDENT_DAY <= b[0] < INCIDENT_DAY + timedelta(days=1)]
    if not same_day:
        return None
    if len(same_day) > 1:
        raise SystemExit(
            f'{len(same_day)} separate bursts on {INCIDENT_DAY.date()}: '
            + ', '.join(f'{s.isoformat()}..{e.isoformat()} ({n})' for s, e, n in same_day)
            + '. Widen BURST_GAP_MINUTES deliberately or purge them one at a time; '
              'refusing to guess which one is the incident.')
    return same_day[0][:2]


def has_app_activity(profile):
    """
    True when anything authenticated has written to this profile.

    False means the row is byte-for-byte what cognito_trigger.py writes on its
    own, so no consent was given, no onboarding finished, no language chosen,
    no child renamed and no document attached. A missing row returns True: an
    absent profile proves nothing, and an unprovable account is one this script
    must not touch.
    """
    if profile is None:
        return True
    if set(profile.keys()) != DEFAULT_PROFILE_KEYS:
        return True
    if profile.get('consentGiven') is not False or profile.get('showOnboarding') is not True:
        return True
    if profile.get('createdAt') != profile.get('updatedAt'):
        return True

    children = profile.get('children') or []
    if len(children) != 1:
        return True
    child = children[0] or {}
    if set(child.keys()) != DEFAULT_CHILD_KEYS:
        return True
    return (child.get('name') != DEFAULT_CHILD_NAME
            or child.get('schoolCity') != DEFAULT_CHILD_CITY)


def evaluate(users, window, profiles, document_user_ids, referral_user_ids, reserved):
    """
    Sort every user into candidates, guarded-out accounts, and the untouched.

    An account is looked at at all if it matches EITHER abuse heuristic on the
    incident day: created inside the burst, or carrying a non-+1 number. It is
    deleted only if it matches BOTH and trips no guard. Everything in between
    comes back in `guarded`, with the reason it was spared.

    Matching on either rather than both is deliberate. The one +1 account
    created in the middle of the burst, and the handful of non-+1 accounts that
    fall just outside it, are precisely the rows a human should look at before
    a thousand deletes run, and requiring both would hide them.
    """
    day_end = INCIDENT_DAY + timedelta(days=1)
    candidates, guarded = [], []
    for user in users:
        phone = user['phone']
        in_window = bool(window) and window[0] <= user['created'] < window[1]
        looks_foreign = bool(phone) and not phone.startswith(ALLOWED_COUNTRY_CODE)
        on_incident_day = INCIDENT_DAY <= user['created'] < day_end

        if not (on_incident_day and (in_window or looks_foreign)):
            continue

        reasons = []
        if not looks_foreign:
            reasons.append(f'G1 {ALLOWED_COUNTRY_CODE} or missing phone number')
        if not in_window:
            reasons.append('created outside the burst window')
        if phone in reserved or FICTIONAL_BLOCK.match(phone):
            reasons.append('G2 reserved test or smoke number')
        if user['sub'] in document_user_ids:
            reasons.append('G3 owns an IEP document')
        if has_app_activity(profiles.get(user['sub'])):
            reasons.append('G4 profile shows app activity, or has no profile row')
        if user['sub'] in referral_user_ids:
            reasons.append('G5 linked to a referral')

        (guarded if reasons else candidates).append({**user, 'guards': reasons})
    return candidates, guarded


def delete_account(user, user_pool_id, profiles_table):
    """Delete the Cognito user and its profile row, then prove both are gone."""
    try:
        cognito.admin_delete_user(UserPoolId=user_pool_id, Username=user['username'])
    except ClientError as err:
        if err.response['Error']['Code'] != 'UserNotFoundException':
            return False, f'account delete failed: {err.response["Error"]["Code"]}'

    try:
        cognito.admin_get_user(UserPoolId=user_pool_id, Username=user['username'])
        return False, 'account still present after delete'
    except ClientError as err:
        if err.response['Error']['Code'] != 'UserNotFoundException':
            return False, f'could not verify account delete: {err.response["Error"]["Code"]}'

    removed_profile = delete_profile(user['sub'], profiles_table)
    if removed_profile is False:
        return False, 'account deleted but its profile row survived'
    return True, ('account and profile deleted' if removed_profile
                  else 'account deleted (no profile row)')


def delete_profile(user_id, profiles_table):
    """Delete one profile row and verify. None when there was nothing to delete."""
    if not user_id:
        return None
    table = dynamodb.Table(profiles_table)
    if not table.get_item(Key={'userId': user_id}, ProjectionExpression='userId').get('Item'):
        return None
    table.delete_item(Key={'userId': user_id})
    still_there = table.get_item(Key={'userId': user_id},
                                ProjectionExpression='userId').get('Item')
    return not still_there


def print_criteria(window, bursts, reserved_count):
    print('\nCriteria used')
    print('  candidate  = created inside the detected burst window')
    print(f'               AND phone_number country code is not {ALLOWED_COUNTRY_CODE}')
    print(f'  signup bursts found in this pool (>= {BURST_ACCOUNTS_PER_MINUTE} signups in a '
          f'minute, joined across gaps under {BURST_GAP_MINUTES} min):')
    for start, end, count in bursts or []:
        span = (end - start).total_seconds() / 60
        marker = '  <-- the incident' if window and start == window[0] else ''
        print(f'      {start.isoformat()} .. {end.isoformat()}  '
              f'{count} accounts in {span:.0f} min{marker}')
    if not bursts:
        print('      (none)')
    if window:
        span = (window[1] - window[0]).total_seconds() / 60
        print(f'  burst window used (derived from the pool, not assumed): '
              f'{window[0].isoformat()} .. {window[1].isoformat()}  ({span:.0f} min)')
    else:
        print(f'  burst window: NONE on {INCIDENT_DAY.date()}, so nothing is a candidate.')
    print('  guards     = G1 +1 or missing phone | G2 reserved test/smoke number '
          f'({reserved_count} known, plus the whole +1 555 555-01XX block)')
    print('               G3 owns an IEP document | G4 profile shows app activity, '
          'or has no profile row')
    print('               G5 linked to a referral')


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--environment', '--env', dest='environment', required=True,
                        choices=('prod', 'staging'),
                        help='required, no default: naming the environment out loud is '
                             'what stops a delete landing in the wrong one')
    parser.add_argument('--apply', action='store_true',
                        help='actually delete (default is a dry run)')
    parser.add_argument('--limit', type=int, help='delete at most N accounts')
    parser.add_argument('--orphan-profiles', action='store_true',
                        help='also purge profile rows whose Cognito user no longer '
                             'exists. Off by default because they are not abuse: they '
                             'are real families whose accounts are already gone')
    args = parser.parse_args()

    resolved = discover(args.environment)
    print(f'environment={args.environment}  pool={resolved["user_pool_id"]}')
    print(f'profiles={resolved["profiles_table"]}')

    reserved = reserved_numbers(args.environment)
    users = list_pool_users(resolved['user_pool_id'])
    bursts = find_bursts(users)
    window = incident_window(bursts)

    if window:
        span_minutes = (window[1] - window[0]).total_seconds() / 60
        if span_minutes > MAX_WINDOW_MINUTES:
            raise SystemExit(
                f'the detected burst spans {span_minutes:.0f} minutes, past the '
                f'{MAX_WINDOW_MINUTES}-minute ceiling; refusing to delete on a window '
                'this wide')

    profiles = {p['userId']: p for p in scan(resolved['profiles_table'])}
    documents = scan(resolved['documents_table'],
                     ProjectionExpression='iepId, childId, userId')
    document_user_ids = {d.get('userId') for d in documents if d.get('userId')}
    referrals = scan(resolved['referrals_table'])
    referral_user_ids = ({r.get('ownerUserId') for r in referrals}
                         | {r.get('referredUserId') for r in referrals}) - {None}

    print(f'\n{len(users)} accounts in the pool, {len(profiles)} profile rows, '
          f'{len(documents)} documents, {len(referrals)} referral rows')
    print_criteria(window, bursts, len(reserved))

    candidates, guarded = evaluate(users, window, profiles, document_user_ids,
                                   referral_user_ids, reserved)

    if len(candidates) > MAX_CANDIDATES:
        raise SystemExit(
            f'{len(candidates)} candidates, past the {MAX_CANDIDATES} ceiling; refusing '
            'to delete on a set this large without someone widening the ceiling on '
            'purpose')

    pool_subs = {u['sub'] for u in users if u['sub']}
    candidate_subs = {c['sub'] for c in candidates}
    orphan_profiles = sorted(set(profiles) - pool_subs)

    print(f'\ncandidate accounts:      {len(candidates)}')
    print(f'guarded out:             {len(guarded)}')
    print(f'orphaned profile rows:   {len(orphan_profiles)}  '
          '(profile exists, Cognito user does not)')
    print(f'profile rows to remove with the accounts: '
          f'{sum(1 for s in candidate_subs if s in profiles)}')

    if candidates:
        countries = {}
        for candidate in candidates:
            code = candidate['phone'][:4]
            countries[code] = countries.get(code, 0) + 1
        top = sorted(countries.items(), key=lambda kv: -kv[1])[:8]
        print('  leading dialling prefixes: '
              + ', '.join(f'{code}xxx={count}' for code, count in top))
        print(f'\n  sample of {min(SAMPLE_SIZE, len(candidates))} (masked):')
        for candidate in candidates[:SAMPLE_SIZE]:
            print(f'    sub {candidate["sub"][:8]}  {mask_phone(candidate["phone"])}  '
                  f'{candidate["status"]}  enabled={candidate["enabled"]}  '
                  f'{candidate["created"].isoformat()}')

    if guarded:
        print(f'\nGUARDED OUT ({len(guarded)}). These matched an abuse heuristic on '
              f'{INCIDENT_DAY.date()} and were spared anyway. Eyeball them:')
        for candidate in guarded[:GUARDED_PRINT_LIMIT]:
            print(f'    sub {candidate["sub"][:8]}  {mask_phone(candidate["phone"])}  '
                  f'{candidate["created"].isoformat()}  -> {"; ".join(candidate["guards"])}')
        if len(guarded) > GUARDED_PRINT_LIMIT:
            print(f'    ... and {len(guarded) - GUARDED_PRINT_LIMIT} more')

    if orphan_profiles:
        print(f'\nORPHANED PROFILE ROWS ({len(orphan_profiles)}). No Cognito user owns '
              'these, so nothing in the app can read or delete them:')
        for user_id in orphan_profiles[:SAMPLE_SIZE]:
            profile = profiles[user_id]
            children = len(profile.get('children') or [])
            print(f'    userId {user_id[:8]}  children={children}  '
                  f'activity={has_app_activity(profile)}')
        if len(orphan_profiles) > SAMPLE_SIZE:
            print(f'    ... and {len(orphan_profiles) - SAMPLE_SIZE} more')
        if not args.orphan_profiles:
            print('    (pass --orphan-profiles to include these in the purge)')

    targets = candidates[:args.limit] if args.limit else candidates
    orphan_targets = orphan_profiles if args.orphan_profiles else []

    if not targets and not orphan_targets:
        print('\nnothing to delete.')
        return 0

    if not args.apply:
        print(f'\nDRY RUN. Would delete {len(targets)} Cognito account(s) with their '
              f'profile rows, and {len(orphan_targets)} orphaned profile row(s).')
        print('Re-run with --apply to do it. Cognito cannot restore a deleted account.')
        return 0

    failures = []
    verified = 0
    if targets:
        print(f'\nDeleting {len(targets)} account(s)...')
        for index, candidate in enumerate(targets, start=1):
            try:
                ok, message = delete_account(candidate, resolved['user_pool_id'],
                                             resolved['profiles_table'])
            except Exception as err:  # noqa: BLE001 - report and continue
                ok, message = False, f'{type(err).__name__}: {str(err)[:200]}'
            if ok:
                verified += 1
            else:
                failures.append((candidate['sub'], message))
            if index % 50 == 0 or index == len(targets):
                print(f'  [{index}/{len(targets)}] {verified} verified, '
                      f'{len(failures)} failed', flush=True)

    orphans_removed, orphan_failures = 0, []
    if orphan_targets:
        print(f'\nDeleting {len(orphan_targets)} orphaned profile row(s)...')
        for user_id in orphan_targets:
            try:
                removed = delete_profile(user_id, resolved['profiles_table'])
            except Exception as err:  # noqa: BLE001 - report and continue
                removed = False
                orphan_failures.append((user_id, f'{type(err).__name__}: {str(err)[:200]}'))
                continue
            if removed:
                orphans_removed += 1
            elif removed is False:
                orphan_failures.append((user_id, 'row survived the delete'))

    print(f'\ndone: {verified} account(s) verified deleted, {len(failures)} failed; '
          f'{orphans_removed} orphaned profile row(s) deleted, '
          f'{len(orphan_failures)} failed')
    for user_id, message in (failures + orphan_failures)[:20]:
        print(f'  FAILED {user_id[:8]}: {message}')
    return 1 if (failures or orphan_failures) else 0


if __name__ == '__main__':
    sys.exit(main())
