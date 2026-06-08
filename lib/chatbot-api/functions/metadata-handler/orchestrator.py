"""
Thin orchestrator Lambda to start the Step Functions state machine
This replaces the monolithic metadata handler
"""
import json
import os
import boto3
import urllib.parse
import traceback

def _safe_event_summary(event):
    """Summarize the trigger event without logging sensitive details.

    The raw S3 notification carries the object key (whose filename may embed a
    student's name) plus requester IP/principal metadata, and a direct
    invocation carries opaque IDs and S3 references. We avoid dumping the whole
    event; the bucket/key are logged after parsing below.
    """
    if not isinstance(event, dict):
        return f"event of type {type(event).__name__}"
    if isinstance(event.get('Records'), list):
        return f"S3 event with {len(event['Records'])} record(s)"
    safe_keys = ('iep_id', 'user_id', 'child_id', 's3_bucket', 's3_key')
    meta = {k: event[k] for k in safe_keys if k in event}
    return f"direct invocation {json.dumps(meta)}"


def lambda_handler(event, context):
    """
    Lightweight orchestrator that starts the Step Functions state machine
    for IEP document processing.
    """
    print(f"Orchestrator received event: {_safe_event_summary(event)}")
    
    try:
        # Extract S3 event info
        if 'Records' in event and len(event['Records']) > 0:
            record = event['Records'][0]
            bucket = record['s3']['bucket']['name']
            key = record['s3']['object']['key']
            key = urllib.parse.unquote_plus(key)
            
            print(f"Processing S3 event for object: {bucket}/{key}")
            
            # Skip content.json files - these are our internal content storage files, not documents to process
            if key.endswith('content.json') or '/content.json' in key:
                print(f"Skipping content.json file: {key} - this is internal content storage, not a document to process")
                return {
                    'statusCode': 200,
                    'body': json.dumps({
                        'message': f'Skipped content.json file: {key}'
                    })
                }
            
            # Extract user ID, child ID, and IEP ID from the key
            key_parts = key.split('/')
            if len(key_parts) < 3:
                print(f"Invalid S3 key format: {key}. Expected: userId/childId/iepId/filename")
                return {
                    'statusCode': 400,
                    'body': json.dumps({
                        'message': f'Invalid S3 key format: {key}'
                    })
                }
            
            user_id = key_parts[0]
            child_id = key_parts[1] 
            iep_id = key_parts[2]
            
            # Also check if the filename is a JSON file (should not process JSON files as documents)
            filename = key_parts[-1] if len(key_parts) > 0 else ''
            if filename.lower().endswith('.json'):
                print(f"Skipping JSON file: {key} - JSON files are not documents to process")
                return {
                    'statusCode': 200,
                    'body': json.dumps({
                        'message': f'Skipped JSON file: {key}'
                    })
                }
            
            print(f"Extracted: user_id={user_id}, child_id={child_id}, iep_id={iep_id}")
            
            # Create Step Functions client
            stepfunctions = boto3.client('stepfunctions')
            
            # Get state machine ARN from environment
            state_machine_arn = os.environ.get('STATE_MACHINE_ARN')
            if not state_machine_arn:
                raise Exception("STATE_MACHINE_ARN environment variable not set")
            
            # Create execution input
            execution_input = {
                'iep_id': iep_id,
                'user_id': user_id,
                'child_id': child_id,
                's3_bucket': bucket,
                's3_key': key,
                'progress': 0,
                'current_step': 'initializing'
            }
            
            # Start the state machine execution
            execution_name = f"iep-processing-{iep_id}-{int(context.aws_request_id[:8], 16)}"
            
            print(f"Starting state machine execution: {execution_name}")
            print(f"Input: {json.dumps(execution_input)}")
            
            response = stepfunctions.start_execution(
                stateMachineArn=state_machine_arn,
                name=execution_name,
                input=json.dumps(execution_input)
            )
            
            execution_arn = response['executionArn']
            print(f"Successfully started execution: {execution_arn}")
            
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'IEP processing started successfully',
                    'executionArn': execution_arn,
                    'iep_id': iep_id,
                    'user_id': user_id,
                    'child_id': child_id
                })
            }
        else:
            # Direct invocation (not S3 event)
            print("Direct invocation - extracting parameters from event body")
            
            # Extract parameters from event
            iep_id = event.get('iep_id')
            user_id = event.get('user_id')
            child_id = event.get('child_id')
            s3_bucket = event.get('s3_bucket')
            s3_key = event.get('s3_key')
            
            if not all([iep_id, user_id, child_id, s3_bucket, s3_key]):
                return {
                    'statusCode': 400,
                    'body': json.dumps({
                        'message': 'Missing required parameters: iep_id, user_id, child_id, s3_bucket, s3_key'
                    })
                }
            
            # Create Step Functions client
            stepfunctions = boto3.client('stepfunctions')
            
            # Get state machine ARN from environment
            state_machine_arn = os.environ.get('STATE_MACHINE_ARN')
            if not state_machine_arn:
                raise Exception("STATE_MACHINE_ARN environment variable not set")
            
            # Create execution input
            execution_input = {
                'iep_id': iep_id,
                'user_id': user_id,
                'child_id': child_id,
                's3_bucket': s3_bucket,
                's3_key': s3_key,
                'progress': 0,
                'current_step': 'initializing'
            }
            
            # Start the state machine execution
            execution_name = f"iep-processing-{iep_id}-{int(context.aws_request_id[:8], 16)}"
            
            print(f"Starting state machine execution: {execution_name}")
            
            response = stepfunctions.start_execution(
                stateMachineArn=state_machine_arn,
                name=execution_name,
                input=json.dumps(execution_input)
            )
            
            execution_arn = response['executionArn']
            print(f"Successfully started execution: {execution_arn}")
            
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'IEP processing started successfully',
                    'executionArn': execution_arn,
                    'iep_id': iep_id
                })
            }
            
    except Exception as e:
        error_message = f"Error starting IEP processing: {str(e)}"
        print(error_message)
        print(traceback.format_exc())
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': error_message
            })
        }
