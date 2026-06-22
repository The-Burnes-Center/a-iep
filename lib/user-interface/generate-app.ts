import * as cdk from "aws-cdk-lib";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { ChatBotApi } from "../chatbot-api";
import { NagSuppressions } from "cdk-nag";
import { getTagProps, tagResource } from '../tags';


export interface WebsiteProps {  
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly api: ChatBotApi;
  readonly websiteBucket: s3.Bucket;
}

export class Website extends Construct {
    readonly distribution: cf.CloudFrontWebDistribution;

  constructor(scope: Construct, id: string, props: WebsiteProps) {
    super(scope, id);

    /////////////////////////////////////
    ///// CLOUDFRONT IMPLEMENTATION /////
    /////////////////////////////////////

    const originAccessIdentity = new cf.OriginAccessIdentity(this, "S3OAI");
    props.websiteBucket.grantRead(originAccessIdentity);    

    // Apply tags to the website bucket
    tagResource(props.websiteBucket, {
      'Resource': 'S3Bucket',
      'Purpose': 'WebHosting'
    });

    const distributionLogsBucket = new s3.Bucket(
      this,
      "DistributionLogsBucket",
      {
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        enforceSSL: true,
      }
    );
    
    // Apply tags to the logs bucket
    tagResource(distributionLogsBucket, {
      'Resource': 'S3Bucket',
      'Purpose': 'CloudFrontLogs'
    });

    const distribution = new cf.CloudFrontWebDistribution(
      this,
      "Distribution",
      {
        ...(process.env.ACM_CERTIFICATE_ARN && process.env.DOMAIN && {
          viewerCertificate: cf.ViewerCertificate.fromAcmCertificate(
            acm.Certificate.fromCertificateArn(this, 'CloudfrontAcm', process.env.ACM_CERTIFICATE_ARN),
            {
              aliases: [process.env.DOMAIN],
            }
          ),
        }),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        priceClass: cf.PriceClass.PRICE_CLASS_ALL,
        httpVersion: cf.HttpVersion.HTTP2_AND_3,
        loggingConfig: {
          bucket: distributionLogsBucket,
        },
        originConfigs: [
          {
            behaviors: [{ 
              isDefaultBehavior: true,
              defaultTtl: cdk.Duration.hours(1),
              maxTtl: cdk.Duration.days(1),
              minTtl: cdk.Duration.minutes(5),
              compress: true,
              allowedMethods: cf.CloudFrontAllowedMethods.GET_HEAD_OPTIONS,
              cachedMethods: cf.CloudFrontAllowedCachedMethods.GET_HEAD,
            }],
            s3OriginSource: {
              s3BucketSource: props.websiteBucket,
              originAccessIdentity,
            },
          },
          {
            behaviors: [
              {
                pathPattern: "/chatbot/files/*",
                allowedMethods: cf.CloudFrontAllowedMethods.ALL,
                viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                defaultTtl: cdk.Duration.seconds(0),
                maxTtl: cdk.Duration.minutes(5),
                minTtl: cdk.Duration.seconds(0),
                compress: true,
                cachedMethods: cf.CloudFrontAllowedCachedMethods.GET_HEAD,
                forwardedValues: {
                  queryString: true,
                  headers: [
                    "Referer",
                    "Origin",
                    "Authorization",
                    "Content-Type",
                    "x-forwarded-user",
                    "Access-Control-Request-Headers",
                    "Access-Control-Request-Method",
                  ],
                },
              },
            ],
            s3OriginSource: {
              s3BucketSource: props.websiteBucket,
              originAccessIdentity,
            },            
          },
        ],
        
        // geoRestriction: cfGeoRestrictEnable ? cf.GeoRestriction.allowlist(...cfGeoRestrictList): undefined,
        errorConfigurations: [
          {
            errorCode: 404,
            errorCachingMinTtl: 0,
            responseCode: 200,
            responsePagePath: "/index.html",
          },
        ],
      }
    );
    
    // Apply tags to the CloudFront distribution
    tagResource(distribution, {
      'Resource': 'CloudFront',
      'Purpose': 'WebsiteDelivery'
    });

    this.distribution = distribution;

    // ###################################################
    // Outputs
    // ###################################################
    new cdk.CfnOutput(this, "UserInterfaceDomainName", {
      value: `https://${distribution.distributionDomainName}`,
    });

    NagSuppressions.addResourceSuppressions(
      distributionLogsBucket,
      [
        {
          id: "AwsSolutions-S1",
          reason: "Bucket is the server access logs bucket for websiteBucket.",
        },
      ]
    );

    NagSuppressions.addResourceSuppressions(props.websiteBucket, [
      { id: "AwsSolutions-S5", reason: "OAI is configured for read." },
    ]);

    NagSuppressions.addResourceSuppressions(distribution, [
      { id: "AwsSolutions-CFR1", reason: "No geo restrictions" },
      {
        id: "AwsSolutions-CFR2",
        reason: "WAF not required due to configured Cognito auth.",
      },
      { id: "AwsSolutions-CFR4", reason: "TLS 1.2 is the default." },
    ]);
    }

  }
