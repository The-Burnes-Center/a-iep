"""
Thin orchestrator Lambda to start the Step Functions state machine
This replaces the monolithic metadata handler
"""
import json
import os
import boto3
import urllib.parse
import traceback

def _stepfunctions_client():
    """Step Functions client factory, kept as a module attribute so tests can
    swap in a fake at the point of use instead of patching boto3 globally."""
    return boto3.client('stepfunctions')


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
            # S3 batches notifications: one event can carry several records,
            # so every record gets the filter/start treatment, not just the
            # first (which used to silently drop the rest of the batch).
            results = []
            executions_started = 0
            stepfunctions = None  # created lazily; skip-only events never need it

            for record in event['Records']:
                bucket = record['s3']['bucket']['name']
                key = record['s3']['object']['key']
                key = urllib.parse.unquote_plus(key)

                print(f"Processing S3 event for object: {bucket}/{key}")

                # Skip content.json files - these are our internal content storage files, not documents to process
                if key.endswith('content.json') or '/content.json' in key:
                    print(f"Skipping content.json file: {key} - this is internal content storage, not a document to process")
                    results.append({'message': f'Skipped content.json file: {key}'})
                    continue

                # Skip generated TTS audio cache writes - not documents to process
                if key.startswith('iep-audio/') or key.lower().endswith(('.mp3', '.wav', '.ogg')):
                    print(f"Skipping generated audio file: {key} - TTS cache, not a document to process")
                    results.append({'message': f'Skipped generated audio file: {key}'})
                    continue

                # Extract user ID, child ID, and IEP ID from the key. The
                # upload lambda always writes userId/childId/iepId/fileName
                # (knowledge-management/upload-s3), so anything shorter is not
                # a document upload; with only 3 segments iep_id would be the
                # filename, whose dots Step Functions rejects in the execution
                # name. Log + skip so one stray object cannot fail the batch.
                key_parts = key.split('/')
                if len(key_parts) < 4:
                    print(f"Skipping S3 key with unexpected format: {key}. Expected: userId/childId/iepId/filename")
                    results.append({'message': f'Skipped S3 key with unexpected format: {key}'})
                    continue

                user_id = key_parts[0]
                child_id = key_parts[1]
                iep_id = key_parts[2]

                # Also check if the filename is a JSON file (should not process JSON files as documents)
                filename = key_parts[-1]
                if filename.lower().endswith('.json'):
                    print(f"Skipping JSON file: {key} - JSON files are not documents to process")
                    results.append({'message': f'Skipped JSON file: {key}'})
                    continue

                print(f"Extracted: user_id={user_id}, child_id={child_id}, iep_id={iep_id}")

                # Get state machine ARN from environment
                state_machine_arn = os.environ.get('STATE_MACHINE_ARN')
                if not state_machine_arn:
                    raise Exception("STATE_MACHINE_ARN environment variable not set")

                if stepfunctions is None:
                    stepfunctions = _stepfunctions_client()

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
                executions_started += 1
                results.append({
                    'message': 'IEP processing started successfully',
                    'executionArn': execution_arn,
                    'iep_id': iep_id,
                    'user_id': user_id,
                    'child_id': child_id
                })

            # Single-record events (the overwhelmingly common case) keep the
            # exact pre-batching response shape for backward compatibility.
            if len(results) == 1:
                return {'statusCode': 200, 'body': json.dumps(results[0])}
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': f'Processed {len(results)} S3 record(s): '
                               f'{executions_started} execution(s) started',
                    'results': results
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
            stepfunctions = _stepfunctions_client()

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
