"""Which languages a parent's documents are translated into.

This is check_language_prefs/handler.py's decision, moved into the OCR step so
the pipeline no longer pays a separate lambda (and a cold start, 1.8s of a
~73s run in prod) for one DynamoDB read. Every step lambda is bundled on its
own, so the logic cannot be imported from there; test_check_language_prefs.py
runs both against the same profiles so they cannot drift apart.

The decision itself is unchanged:
  * primaryLanguage and secondaryLanguage from the parent's profile, English
    excluded, empty values skipped, duplicates collapsed;
  * no profile means no translation;
  * a failed profile read is swallowed and means no translation too. That is a
    known fail-open, pinned on purpose in test_check_language_prefs.py: the
    parent still gets the English summary and is offered "Translate it now".
A missing USER_PROFILES_TABLE is configuration, not a read failure, and still
raises.
"""
import os

import boto3


def target_languages_for(user_id):
    """The non-English language codes this user wants, sorted, possibly empty."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['USER_PROFILES_TABLE'])

    try:
        response = table.get_item(Key={'userId': user_id})
        profile = response.get('Item')
        if profile is None:
            print(f"No user profile found for {user_id}, no translation needed")
            return []

        languages = {
            language
            for language in (profile.get('primaryLanguage'), profile.get('secondaryLanguage'))
            if language and language != 'en'
        }
        return sorted(languages)
    except Exception as e:  # noqa: BLE001 - deliberately fail-open, see module docstring
        # The class only: an SDK message can carry table names and request ids.
        print(f"Error accessing user profile for {user_id}: {type(e).__name__}")
        return []
