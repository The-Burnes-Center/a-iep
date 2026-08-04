import * as cdk from "aws-cdk-lib";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import {
  ExecSyncOptionsWithBufferEncoding,
  execSync,
} from "node:child_process";
import * as path from "node:path";
import { ChatBotApi } from "../chatbot-api";
import { Website } from "./generate-app"
import { NagSuppressions } from "cdk-nag";
import { Utils } from "../shared/utils"
import { OIDCIntegrationName } from "../constants";
import { getEnvironment } from "../tags";

// Languages offered in the UI per environment. Arabic ships on dev/staging but
// not prod; an explicit ENABLED_LANGUAGES env var (comma-separated codes)
// overrides the default. Kept in sync with the dev-build logic in
// lib/user-interface/app/vite.config.ts.
const ALL_LANGUAGES = ["en", "es", "zh", "vi", "ar"];
const PROD_LANGUAGES = ["en", "es", "zh", "vi"];
function resolveEnabledLanguages(): string[] {
  const override = process.env.ENABLED_LANGUAGES;
  if (override) {
    return override.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return getEnvironment() === "prod" ? PROD_LANGUAGES : ALL_LANGUAGES;
}

// Optional features offered in the UI per environment, same mechanism as the
// languages above. TTS, referrals and the parent-name gate run on dev/staging
// but are dark on prod: the code ships and the backend (audio lambda, referral
// table and routes) stays deployed and unused, so prod and staging keep
// building from one source and enabling a feature is a config flip rather than
// a release. An explicit ENABLED_FEATURES env var (comma-separated names)
// overrides the default. Kept in sync with the dev-build logic in
// lib/user-interface/app/vite.config.ts, and with the feature list in
// lib/user-interface/app/src/common/features.ts.
export const ALL_FEATURES = ["tts", "referrals", "parentNameGate"];
// Referrals went live on prod 2026-08-04: the invite entry point in Account
// Center is all the flag gates, and the referral table and routes were already
// deployed and idle. TTS and the parent-name gate stay dark.
export const PROD_FEATURES: string[] = ["referrals"];
function resolveEnabledFeatures(): string[] {
  const override = process.env.ENABLED_FEATURES;
  if (override) {
    return override.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return getEnvironment() === "prod" ? PROD_FEATURES : ALL_FEATURES;
}

export interface UserInterfaceProps {
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly api: ChatBotApi;
  readonly cognitoDomain : string;
}

export class UserInterface extends Construct {
  public readonly websiteDistribution: cf.CloudFrontWebDistribution;

  constructor(scope: Construct, id: string, props: UserInterfaceProps) {
    super(scope, id);

    const appPath = path.join(__dirname, "app");
    const buildPath = path.join(appPath, "dist");

    const uploadLogsBucket = new s3.Bucket(this, "WebsiteLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      enforceSSL: true,
      versioned: true,
    });

    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: false,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: uploadLogsBucket,
    });

    // Deploy either Private (only accessible within VPC) or Public facing website
    let apiEndpoint: string;
    let distribution;

    const publicWebsite = new Website(this, "Website", { ...props, websiteBucket: websiteBucket });
    distribution = publicWebsite.distribution
    this.websiteDistribution = distribution;

    const exportsAsset = s3deploy.Source.jsonData("aws-exports.json", {
      Auth: {
        region: cdk.Aws.REGION,
        userPoolId: props.userPoolId,
        userPoolWebClientId: props.userPoolClientId,
        oauth: {
          domain: props.cognitoDomain.concat(`.auth.${cdk.Aws.REGION}.amazoncognito.com`),
          scope: ["aws.cognito.signin.user.admin","email", "openid", "profile"],
          redirectSignIn: "https://" + distribution.distributionDomainName,
          redirectSignOut: "https://" + distribution.distributionDomainName,
          responseType: "code"
        }
      },
      httpEndpoint : props.api.httpAPI.restAPI.url,
      federatedSignInProvider : OIDCIntegrationName,
      enabledLanguages : resolveEnabledLanguages(),
      enabledFeatures : resolveEnabledFeatures(),
      // Gates prod-only frontend integrations (Google Analytics), since
      // staging and prod are otherwise identical production builds.
      environment : getEnvironment()
    });

    const asset = s3deploy.Source.asset(appPath, {
      bundling: {
        image: cdk.DockerImage.fromRegistry(
          "public.ecr.aws/sam/build-nodejs18.x:latest"
        ),
        command: [
          "sh",
          "-c",
          [
            "npm --cache /tmp/.npm install",
            `npm --cache /tmp/.npm run build`,
            "cp -aur /asset-input/dist/* /asset-output/",
          ].join(" && "),
        ],
        local: {
          tryBundle(outputDir: string) {
            try {
              const options: ExecSyncOptionsWithBufferEncoding = {
                stdio: "inherit",
                env: {
                  ...process.env,
                },
              };

              console.log('Installing dependencies...');
              execSync(`npm --silent --prefix "${appPath}" ci`, options);
              
              console.log('Building application...');
              execSync(`npm --silent --prefix "${appPath}" run build`, options);
              
              console.log('Copying build files...');
              try {
                Utils.copyDirRecursive(buildPath, outputDir);
                console.log('Build process completed successfully');
              } catch (e) {
                console.error('Failed to copy build files:', e);
                return false;
              }
            } catch (e) {
              console.error('Build process failed:', e);
              return false;
            }

            return true;
          },
        },
      },
    });

    new s3deploy.BucketDeployment(this, "UserInterfaceDeployment", {
      prune: false,
      sources: [asset, exportsAsset],
      destinationBucket: websiteBucket,
      distribution: distribution,
      // Versioned destination bucket + prune:false has accumulated many
      // object versions over time, so the helper Lambda's `aws s3 sync`
      // listing pass takes much longer than the 128MB / 512MB defaults
      // can handle, causing the custom resource to time out (>60min).
      // Give it more headroom so the sync completes within Lambda's 15min
      // limit and CloudFormation's 60min custom-resource cutoff.
      memoryLimit: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(1),
    });


    /**
     * CDK NAG suppression
     */
    NagSuppressions.addResourceSuppressions(
      uploadLogsBucket,
      [
        {
          id: "AwsSolutions-S1",
          reason: "Bucket is the server access logs bucket for websiteBucket.",
        },
      ]
    );
  }
}
