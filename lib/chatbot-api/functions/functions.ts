import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

// Import Lambda L2 construct
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { getTagProps, tagResource } from '../../tags';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { getEnvironment } from '../../tags';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

export interface LambdaFunctionStackProps {
  readonly knowledgeBucket : s3.Bucket;
  readonly userProfilesTable : Table;
  readonly iepDocumentsTable : Table;
  readonly userPool: cognito.UserPool;
  readonly logGroup: logs.LogGroup;
  readonly logRole: iam.Role;
  readonly kmsKey?: kms.IKey;
}

export class LambdaFunctionStack extends cdk.Stack {  
  public readonly deleteS3Function : lambda.Function;
  public readonly getS3KnowledgeFunction : lambda.Function;
  public readonly uploadS3KnowledgeFunction : lambda.Function;
  public readonly userProfileFunction : lambda.Function;
  public readonly cognitoTriggerFunction : lambda.Function;
  public readonly pdfGeneratorFunction : lambda.Function;
  
  // Step Functions components
  public readonly orchestratorFunction : lambda.Function;
  public readonly iepProcessingStateMachine : stepfunctions.StateMachine;
  
  // Step function Lambda handlers
  public readonly ddbServiceFunction : lambda.Function;
  public readonly mistralOCRFunction : lambda.Function;
  public readonly redactOCRFunction : lambda.Function;
  public readonly deleteOriginalFunction : lambda.Function;
  public readonly parsingAgentFunction : lambda.Function;
  public readonly extractMeetingNotesFunction : lambda.Function;
  public readonly checkLanguagePrefsFunction : lambda.Function;
  public readonly translateContentFunction : lambda.Function;
  public readonly finalizeResultsFunction : lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaFunctionStackProps) {
    super(scope, id);    

    // Create a helper function to add standard tags and handle Lambda function creation
    const createTaggedLambda = (id: string, config: lambda.FunctionProps): lambda.Function => {
      const func = new lambda.Function(scope, id, {
        ...config
      });
      
      // Apply standard tags plus Lambda-specific tags
      tagResource(func, {
        'Resource': 'Lambda',
        'Function': id,
        'Runtime': config.runtime?.name || 'unknown'
      });
      
      return func;
    };
    
    const deleteS3APIHandlerFunction = new lambda.Function(scope, 'DeleteS3FilesHandlerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/delete-s3')), // Points to the lambda directory
      handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "BUCKET" : props.knowledgeBucket.bucketName,        
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_YEAR,
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    // Scope to only the operation the handler actually needs.
    deleteS3APIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:DeleteObject'
      ],
      resources: [props.knowledgeBucket.bucketArn + "/*"]
    }));

    this.deleteS3Function = deleteS3APIHandlerFunction;

    const getS3APIHandlerFunction = new lambda.Function(scope, 'GetS3FilesHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/get-s3')), // Points to the lambda directory
      handler: 'index.handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "BUCKET" : props.knowledgeBucket.bucketName,        
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_YEAR,
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    getS3APIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:*'
      ],
      resources: [props.knowledgeBucket.bucketArn,props.knowledgeBucket.bucketArn+"/*"]
    }));

    this.getS3KnowledgeFunction = getS3APIHandlerFunction;

    const uploadS3KnowledgeAPIHandlerFunction = createTaggedLambda('UploadS3KnowledgeFilesHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/upload-s3')),
      handler: 'index.handler',
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
        "IEP_DOCUMENTS_TABLE": props.iepDocumentsTable.tableName,
        "USER_PROFILES_TABLE": props.userProfilesTable.tableName
      },
      timeout: cdk.Duration.seconds(300),
      logRetention: logs.RetentionDays.ONE_YEAR,
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    uploadS3KnowledgeAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:*'
      ],
      resources: [props.knowledgeBucket.bucketArn, props.knowledgeBucket.bucketArn + "/*"]
    }));

    // Add DynamoDB permissions for IEP documents table
    uploadS3KnowledgeAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:PutItem',
        'dynamodb:GetItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem'
      ],
      resources: [
        props.iepDocumentsTable.tableArn,
        `${props.iepDocumentsTable.tableArn}/index/byChildId`
      ]
    }));
    
    // Add DynamoDB permissions for user profiles table
    uploadS3KnowledgeAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem'
      ],
      resources: [props.userProfilesTable.tableArn]
    }));
    
    this.uploadS3KnowledgeFunction = uploadS3KnowledgeAPIHandlerFunction;

    // Note: legacy monolithic metadata handler removed in favor of Step Functions orchestrator

    // ==========================================
    // STEP FUNCTIONS REFACTORED METADATA HANDLER
    // ==========================================

    // Create DDB service function first so we can reference it in environment variables
    this.ddbServiceFunction = createTaggedLambda('DDBServiceFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'metadata-handler/ddb-service'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt --platform manylinux2014_x86_64 --only-binary=:all: -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'handler.lambda_handler',
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
        "IEP_DOCUMENTS_TABLE": props.iepDocumentsTable.tableName,
        "USER_PROFILES_TABLE": props.userProfilesTable.tableName,
        // SSM parameter names for encrypted API keys (runtime fetch with caching)
        "OPENAI_API_KEY_PARAMETER_NAME": "/ai-iep/OPENAI_API_KEY",
        "MISTRAL_API_KEY_PARAMETER_NAME": "/ai-iep/MISTRAL_API_KEY"
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    // Common environment variables for step functions
    const stepFunctionEnvVars = {
      "BUCKET": props.knowledgeBucket.bucketName,
      "IEP_DOCUMENTS_TABLE": props.iepDocumentsTable.tableName,
      "USER_PROFILES_TABLE": props.userProfilesTable.tableName,
      "DDB_SERVICE_FUNCTION_NAME": this.ddbServiceFunction.functionName,
      // SSM parameter names for encrypted API keys (runtime fetch with caching)
      "OPENAI_API_KEY_PARAMETER_NAME": "/ai-iep/OPENAI_API_KEY",
      "MISTRAL_API_KEY_PARAMETER_NAME": "/ai-iep/MISTRAL_API_KEY"
    };

    // Common permissions for step function Lambdas
    const stepFunctionPolicies = [
      // S3 permissions
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject', 
          's3:DeleteObject',
          's3:ListBucket',
          's3:GetBucketLocation'
        ],
        resources: [
          props.knowledgeBucket.bucketArn,
          props.knowledgeBucket.bucketArn + "/*"
        ]
      }),
      // DynamoDB permissions
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
          'dynamodb:Scan'
        ],
        resources: [
          props.iepDocumentsTable.tableArn,
          props.userProfilesTable.tableArn
        ]
      }),
      // Note: SSM permissions removed - API keys now passed as environment variables
      // Comprehend permissions
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'comprehend:BatchDetectPiiEntities',
          'comprehend:DetectPiiEntities'
        ],
        resources: ['*']
      }),
      // SSM permissions for API key retrieval
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameter'
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-iep/OPENAI_API_KEY`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-iep/MISTRAL_API_KEY`
        ]
      }),
      // Bedrock permissions  
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:Retrieve',
          'bedrock-agent-runtime:Retrieve'
        ],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0`,
          '*'
        ]
      })
    ];

    // Helper function to create step function Lambdas
    const createStepFunctionLambda = (name: string, handlerPath: string, timeout: number = 300): lambda.Function => {
      const func = createTaggedLambda(name, {
        runtime: lambda.Runtime.PYTHON_3_12,
        code: lambda.Code.fromAsset(path.join(__dirname, handlerPath), {
          bundling: {
            image: lambda.Runtime.PYTHON_3_12.bundlingImage,
            command: [
              'bash', '-c',
              'pip install -r requirements.txt --platform manylinux2014_x86_64 --only-binary=:all: -t /asset-output && cp -au . /asset-output'
            ],
          },
        }),
        handler: 'handler.lambda_handler',
        environment: stepFunctionEnvVars,
        timeout: cdk.Duration.seconds(timeout),
        memorySize: 1024,
        ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
      });
      
      // Add common policies to each step function
      stepFunctionPolicies.forEach(policy => func.addToRolePolicy(policy));
      
      return func;
    };

    // DDB service function already created above with proper environment variables

    // Create core business logic step functions (no more individual DDB operations)
    // Note: Removed updateDDBStartFunction - replaced by DDB service calls

    this.mistralOCRFunction = createStepFunctionLambda(
      'MistralOCRFunction', 
      'metadata-handler/steps/mistral_ocr',
      600
    );

    this.redactOCRFunction = createStepFunctionLambda(
      'RedactOCRFunction',
      'metadata-handler/steps/redact_ocr', 
      300
    );

    this.deleteOriginalFunction = createStepFunctionLambda(
      'DeleteOriginalFunction',
      'metadata-handler/steps/delete_original',
      60
    );

    this.parsingAgentFunction = createStepFunctionLambda(
      'ParsingAgentFunction',
      'metadata-handler/steps/parsing_agent',
      900
    );

    this.extractMeetingNotesFunction = createStepFunctionLambda(
      'ExtractMeetingNotesFunction',
      'metadata-handler/steps/extract_meeting_notes',
      300
    );

    // Note: Removed saveEnglishFunction, saveFinalFunction, recordFailureFunction - replaced by DDB service calls


    this.checkLanguagePrefsFunction = createStepFunctionLambda(
      'CheckLanguagePrefsFunction',
      'metadata-handler/steps/check_language_prefs',
      60
    );

    this.translateContentFunction = createStepFunctionLambda(
      'TranslateContentFunction',
      'metadata-handler/steps/translate_content',
      600
    );


    this.finalizeResultsFunction = createStepFunctionLambda(
      'FinalizeResultsFunction',
      'metadata-handler/steps/finalize_results',
      300
    );

    // Add step function policies to DDB service function (created before stepFunctionPolicies were defined)
    stepFunctionPolicies.forEach(policy => this.ddbServiceFunction.addToRolePolicy(policy));

    // Grant step functions permission to invoke DDB service
    const functionsNeedingDDBAccess = [
      this.mistralOCRFunction,
      this.redactOCRFunction,
      this.parsingAgentFunction,
      this.extractMeetingNotesFunction,
      this.translateContentFunction,
      this.finalizeResultsFunction
    ];

    functionsNeedingDDBAccess.forEach(func => {
      func.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [this.ddbServiceFunction.functionArn]
      }));
    });

    // Load and customize the ASL definition
    const aslPath = path.join(__dirname, '../state-machines/iep-processing.asl.json');
    let aslDefinition = JSON.parse(fs.readFileSync(aslPath, 'utf8'));
    
    // Replace ARN placeholders with actual Lambda ARNs  
    const aslString = JSON.stringify(aslDefinition)
      .replace(/\$\{DDBServiceArn\}/g, this.ddbServiceFunction.functionArn)
      .replace(/\$\{MistralOCRArn\}/g, this.mistralOCRFunction.functionArn)
      .replace(/\$\{RedactOCRArn\}/g, this.redactOCRFunction.functionArn)
      .replace(/\$\{DeleteOriginalArn\}/g, this.deleteOriginalFunction.functionArn)
      .replace(/\$\{ParsingAgentArn\}/g, this.parsingAgentFunction.functionArn)
      .replace(/\$\{ExtractMeetingNotesArn\}/g, this.extractMeetingNotesFunction.functionArn)
      .replace(/\$\{CheckLanguagePrefsArn\}/g, this.checkLanguagePrefsFunction.functionArn)
      .replace(/\$\{TranslateContentArn\}/g, this.translateContentFunction.functionArn)
      .replace(/\$\{FinalizeResultsArn\}/g, this.finalizeResultsFunction.functionArn);
    
    aslDefinition = JSON.parse(aslString);

    // Create Step Functions state machine
    this.iepProcessingStateMachine = new stepfunctions.StateMachine(scope, 'IEPProcessingStateMachine', {
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(aslDefinition)),
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(30)
    });

    // Add explicit dependencies to ensure all Lambda functions are created before state machine
    this.iepProcessingStateMachine.node.addDependency(this.ddbServiceFunction);
    this.iepProcessingStateMachine.node.addDependency(this.mistralOCRFunction);
    this.iepProcessingStateMachine.node.addDependency(this.redactOCRFunction);
    this.iepProcessingStateMachine.node.addDependency(this.deleteOriginalFunction);
    this.iepProcessingStateMachine.node.addDependency(this.parsingAgentFunction);
    this.iepProcessingStateMachine.node.addDependency(this.extractMeetingNotesFunction);
    this.iepProcessingStateMachine.node.addDependency(this.checkLanguagePrefsFunction);
    this.iepProcessingStateMachine.node.addDependency(this.translateContentFunction);
    this.iepProcessingStateMachine.node.addDependency(this.finalizeResultsFunction);

    // Grant the state machine permission to invoke all step functions
    const stepFunctionsList = [
      this.ddbServiceFunction,
      this.mistralOCRFunction,
      this.redactOCRFunction,
      this.deleteOriginalFunction,
      this.parsingAgentFunction,
      this.extractMeetingNotesFunction,
      this.checkLanguagePrefsFunction,
      this.translateContentFunction,
      this.finalizeResultsFunction
    ];
    
    stepFunctionsList.forEach(func => {
      func.grantInvoke(this.iepProcessingStateMachine.role);
    });

    // Create the orchestrator Lambda that starts the state machine
    this.orchestratorFunction = createTaggedLambda('OrchestratorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'metadata-handler'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt --platform manylinux2014_x86_64 --only-binary=:all: -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'orchestrator.lambda_handler',
      environment: {
        ...stepFunctionEnvVars,
        STATE_MACHINE_ARN: this.iepProcessingStateMachine.stateMachineArn
      },
      timeout: cdk.Duration.seconds(60),
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    // Grant orchestrator permission to start state machine executions
    this.iepProcessingStateMachine.grantStartExecution(this.orchestratorFunction);

    // Replace the S3 trigger: use orchestrator instead of monolithic handler
    this.orchestratorFunction.addEventSource(new S3EventSource(props.knowledgeBucket, {
      events: [s3.EventType.OBJECT_CREATED],
    }));

    // Apply KMS policies to new step function Lambdas if needed
    if (props.kmsKey) {
      const kmsPolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey'
        ],
        resources: [props.kmsKey.keyArn]
      });

      [
        this.ddbServiceFunction,
        this.mistralOCRFunction,
        this.redactOCRFunction,
        this.deleteOriginalFunction,
        this.parsingAgentFunction,
        this.extractMeetingNotesFunction,
        this.checkLanguagePrefsFunction,
        this.translateContentFunction,
        this.finalizeResultsFunction,
        this.orchestratorFunction
      ].forEach(func => func.addToRolePolicy(kmsPolicy));
    }

    // ==========================================
    // END OF STEP FUNCTIONS COMPONENTS
    // ==========================================

    const userProfileHandlerFunction = new lambda.Function(scope, 'UserProfileHandlerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'user-profile-handler')),
      handler: 'lambda_function.lambda_handler',
      environment: {
        "USER_PROFILES_TABLE": props.userProfilesTable.tableName,
        "IEP_DOCUMENTS_TABLE": props.iepDocumentsTable.tableName,
        "BUCKET": props.knowledgeBucket.bucketName,
        "USER_POOL_ID": props.userPool.userPoolId,
        "DDB_SERVICE_FUNCTION_NAME": this.ddbServiceFunction.functionName,
        "AIEP_KMS_KEY_ALIAS": ((): string => {
          const env = getEnvironment();
          return env === 'staging' ? 'alias/aiep/app' : 'alias/aiep/app-prod';
        })()
      },
      timeout: cdk.Duration.seconds(300),
      logRetention: logs.RetentionDays.ONE_YEAR,
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    // Add permissions for DynamoDB tables
    userProfileHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan'
      ],
      resources: [
        props.userProfilesTable.tableArn,
        props.userProfilesTable.tableArn + "/index/*",
        props.iepDocumentsTable.tableArn,
        props.iepDocumentsTable.tableArn + "/index/*"
      ]
    }));
    
    // Add S3 permissions
    userProfileHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:GetObject',
        's3:DeleteObject'
      ],
      resources: [
        props.knowledgeBucket.bucketArn,
        props.knowledgeBucket.bucketArn + "/*"
      ]
    }));

    // Add Cognito permissions for user deletion and locale attribute sync
    userProfileHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminUpdateUserAttributes'
      ],
      resources: [props.userPool.userPoolArn]
    }));
    
    // Add Lambda invoke permissions to call DDB service
    userProfileHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:InvokeFunction'
      ],
      resources: [this.ddbServiceFunction.functionArn]
    }));

    this.userProfileFunction = userProfileHandlerFunction;

    // Add Cognito Post Confirmation Trigger Lambda
    const cognitoTriggerFunction = new lambda.Function(scope, 'CognitoTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'user-profile-handler')),
      handler: 'cognito_trigger.lambda_handler',
      environment: {
        "USER_PROFILES_TABLE": props.userProfilesTable.tableName
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_YEAR,
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    // Grant DynamoDB permissions to Cognito trigger
    cognitoTriggerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:PutItem'
      ],
      resources: [props.userProfilesTable.tableArn]
    }));

    // Allow Cognito to invoke the Lambda
    cognitoTriggerFunction.addPermission('CognitoInvocation', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: props.userPool.userPoolArn
    });

    // Add the Lambda trigger to Cognito User Pool
    props.userPool.addTrigger(
      cdk.aws_cognito.UserPoolOperation.POST_CONFIRMATION,
      cognitoTriggerFunction
    );

    this.cognitoTriggerFunction = cognitoTriggerFunction;

    // Common environment variables for all functions
    const commonEnvVars = {
      LOG_GROUP_NAME: props.logGroup.logGroupName,
      ENVIRONMENT: process.env.ENVIRONMENT || 'development',
    };

    // PDF Generator Lambda Function
    const pdfGeneratorFunction = createTaggedLambda('PDFGeneratorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, 'pdf-generator'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm --cache /tmp/.npm install && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(120), // Increase timeout for PDF generation
      memorySize: 1536, // Increase memory for Chromium
      logRetention: logs.RetentionDays.ONE_YEAR,
      environment: {
        ...commonEnvVars
      },
      ...(props.kmsKey ? { environmentEncryption: props.kmsKey } : {})
    });

    this.pdfGeneratorFunction = pdfGeneratorFunction;

    // Create a layer for logging
    const loggingLayer = new lambda.LayerVersion(this, 'LoggingLayer', {
      code: lambda.Code.fromAsset('lib/chatbot-api/logging'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      description: 'Layer for logging functionality',
    });

    // Common IAM permissions for logging
    const loggingPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [props.logGroup.logGroupArn],
    });

    // Add logging permissions to each function
    this.userProfileFunction.addToRolePolicy(loggingPolicy);
    this.pdfGeneratorFunction.addToRolePolicy(loggingPolicy);

    // Grant KMS permissions to functions when a CMK is supplied
    if (props.kmsKey) {
      const kmsPolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey'
        ],
        resources: [props.kmsKey.keyArn]
      });

      deleteS3APIHandlerFunction.addToRolePolicy(kmsPolicy);
      getS3APIHandlerFunction.addToRolePolicy(kmsPolicy);
      uploadS3KnowledgeAPIHandlerFunction.addToRolePolicy(kmsPolicy);
      // Legacy metadata handler removed
      userProfileHandlerFunction.addToRolePolicy(kmsPolicy);
      // Cognito trigger and PDF generator don't need direct KMS usage beyond env, skip
    }
  }
}
