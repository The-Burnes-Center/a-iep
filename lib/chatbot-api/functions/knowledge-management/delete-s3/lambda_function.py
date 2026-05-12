import json
import boto3
import os


def _cors_response(status_code, message):
    return {
        'statusCode': status_code,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
        },
        'body': json.dumps({'message': message}),
    }


def lambda_handler(event, context):
    try:
        payload = json.loads(event['body']) if event.get('body') else {}
    except (TypeError, ValueError):
        return _cors_response(400, 'Invalid JSON body')

    key = payload.get('KEY')
    if not key or not isinstance(key, str):
        return _cors_response(400, 'KEY is required')

    try:
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return _cors_response(401, 'Unauthorized')

    # Ownership check: S3 keys are stored under `{userId}/{childId}/{iepId}/{filename}`.
    # Reject any attempt to delete keys that don't belong to the authenticated user,
    # including path-traversal-style attempts (e.g. `userId/../other/...`).
    expected_prefix = f"{user_id}/"
    if not key.startswith(expected_prefix) or '..' in key.split('/'):
        print(f"Access denied: user {user_id} attempted to delete key {key}")
        return _cors_response(403, 'Access denied: cannot delete files belonging to other users')

    try:
        s3 = boto3.resource('s3')
        s3.Object(os.environ['BUCKET'], key).delete()
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json',
            },
            'body': json.dumps({'message': 'Deleted', 'key': key}),
        }
    except Exception as e:
        print(f"Error deleting S3 object {key}: {str(e)}")
        return _cors_response(502, 'FAILED')
