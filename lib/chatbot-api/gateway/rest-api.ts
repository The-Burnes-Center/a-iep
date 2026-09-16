import * as path from "path";
import * as cdk from "aws-cdk-lib";

import { Construct } from "constructs";
import { Duration, aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";

import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
// import { Shared } from "../shared";
import * as appsync from "aws-cdk-lib/aws-appsync";
// import { parse } from "graphql";
import { readFileSync } from "fs";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface RestBackendAPIProps {
  // Add any required props
}

/**
 * The $default stage's access-log line, as a single JSON object built from
 * API Gateway's $context variables (audit finding #7: a request the JWT
 * authorizer rejects is recorded nowhere today, and the two intentionally
 * unauthenticated routes -- POST /auth/signup, POST /referral/click -- have
 * no visibility into load at all).
 *
 * Consulted: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging.html
 * (setup, permissions, AWS's own CLF/JSON/XML/CSV example formats) and
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html
 * (the full $context variable reference for HTTP APIs). None of AWS's own
 * example formats are used verbatim: every one of them logs
 * $context.identity.sourceIp, and CLF/CSV/XML also log $context.routeKey
 * without addressing $context.path as a separate, leakier variable -- both
 * choices this app cannot make. FERPA-protected families' data flows through
 * routes shaped like /profile/children/{childId}/documents/{iepId}, so:
 *
 *  - $context.routeKey, never $context.path. routeKey is the ROUTE TEMPLATE
 *    ("GET /profile/children/{childId}/documents"), literal placeholder text
 *    and nothing else. path is the RESOLVED request path and would put a
 *    real childId/iepId/referral code/admin username in every log line --
 *    exactly the identifier this pin exists to keep out.
 *  - No query string. HTTP APIs expose no $context variable for it at all
 *    (confirmed against the full reference above), so leaving it out is
 *    automatic rather than a field this format had to remember to drop.
 *  - No $context.identity.* (sourceIp, cognitoIdentityId, caller, user,
 *    userArn, accountId, principalOrgId, clientCert.*). Every one of these
 *    either names the caller directly or is an IAM-authorizer field this
 *    JWT-authorized API never populates. Source IP is left out deliberately,
 *    even though it is in every AWS example format: on the two unauthenticated
 *    routes an IP address alone can identify a household, and this API does
 *    not need it in the access log to do its job -- signup abuse is already
 *    rate-limited by IP inside signup-endpoint.js (MAX_SIGNUPS_PER_IP_HOUR in
 *    new-auth.ts), which counts requests rather than logging addresses.
 *  - No $context.authorizer.claims.* (Cognito sub, username, custom:role).
 *    That is the JWT's own claims, i.e. the literal per-user identifier this
 *    pin is most about keeping out. $context.authorizer.error IS kept: it is
 *    the JWT authorizer's own failure reason (token missing, expired,
 *    invalid), not anything about who was rejected, and it is the one field
 *    that makes an authorizer rejection visible at all.
 *
 * What is left answers exactly the audit finding -- which route, which
 * method, whether the authorizer or the gateway rejected the call and why,
 * how long it took, how often -- without a single user-supplied value.
 */
const ACCESS_LOG_FORMAT = JSON.stringify({
  requestId: '$context.requestId',
  requestTime: '$context.requestTime',
  httpMethod: '$context.httpMethod',
  routeKey: '$context.routeKey',
  status: '$context.status',
  responseLatency: '$context.responseLatency',
  authorizerError: '$context.authorizer.error',
  gatewayErrorType: '$context.error.responseType',
});

export class RestBackendAPI extends Construct {
  public readonly restAPI: apigwv2.HttpApi;
  /** Exposed for tests; not user data, see ACCESS_LOG_FORMAT above. */
  public readonly accessLogGroup: logs.LogGroup;
  constructor(scope: Construct, id: string, props: RestBackendAPIProps) {
    super(scope, id);

    const httpApi = new apigwv2.HttpApi(this, 'HTTP-API', {
      corsPreflight: {
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
          'Accept',
          'Origin',
          'Access-Control-Request-Method',
          'Access-Control-Request-Headers'
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.HEAD,
          apigwv2.CorsHttpMethod.OPTIONS,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowOrigins: ['*'],
        maxAge: Duration.days(10),
        exposeHeaders: ['*'],
        allowCredentials: false
      },
      // The following settings tell API Gateway to automatically handle OPTIONS
      // requests at the gateway level without passing them to Lambda
      defaultIntegration: undefined,
      disableExecuteApiEndpoint: false,
    });
    this.restAPI = httpApi;

    // ── Access logging (audit finding #7) ──────────────────────────────────
    // DESTROY: this is an operational access log, not user data -- the same
    // category as DistributionLogsBucket (CloudFront's own access logs),
    // which is also DESTROY + no retention promise. Losing it costs nothing a
    // family's account depends on. ONE_MONTH matches the retention already
    // used for the alert-formatter and daily-brief lambdas in monitoring.ts.
    //
    // Not encrypted with the app CMK: ACCESS_LOG_FORMAT is designed to carry
    // no FERPA-scoped content (see its docblock), and RestBackendAPIProps
    // takes no kmsKey today, so threading one through would mean changing the
    // call site in chatbot-api/index.ts. CloudWatch Logs still encrypts at
    // rest with an AWS-owned key regardless.
    this.accessLogGroup = new logs.LogGroup(this, 'AccessLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // HttpApi's L2 surface has no accessLogSettings of its own (unlike the v1
    // RestApi construct) -- CloudFormation only exposes AccessLogSettings on
    // the stage -- so this drops to the L1 CfnStage under the default stage
    // createDefaultStage (on by default, and left on above) creates
    // automatically. Same escape hatch already used on the user pool
    // elsewhere in this app (cfnUserPool.smsConfiguration in new-auth.ts).
    //
    // No extra IAM wiring needed: unlike REST APIs (v1, which need an
    // account-level AWS::ApiGateway::Account CloudWatch role), HTTP APIs (v2)
    // deliver access logs through CloudWatch's common log-delivery
    // infrastructure, which manages the destination's resource policy itself.
    if (!httpApi.defaultStage) {
      // Would mean createDefaultStage was turned off above; fail the build
      // rather than silently ship an API with no access logging.
      throw new Error(
        'RestBackendAPI: no default stage to attach access logging to. ' +
        'createDefaultStage must stay true.',
      );
    }
    const cfnStage = httpApi.defaultStage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: this.accessLogGroup.logGroupArn,
      format: ACCESS_LOG_FORMAT,
    };
  }
}
