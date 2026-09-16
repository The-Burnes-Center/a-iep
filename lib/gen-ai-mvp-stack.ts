import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ChatBotApi } from "./chatbot-api";
import * as kms from 'aws-cdk-lib/aws-kms';
import { cognitoDomainName } from "./constants"
import { NewAuthorizationStack } from "./authorization/new-auth"
import { UserInterface } from "./user-interface"
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { applyTags, getResourceName } from './tags';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class GenAiMvpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'GenAiMvpQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
    // let authentication;
    // if (AUTHENTICATION) {
    //   authentication = new AuthorizationStack(this, "Authorization")
    // }
    
    // Create the ChatBot API first to get the user profiles table
    const chatbotAPI = new ChatBotApi(this, getResourceName("ChatbotAPI"), {
      authentication: undefined // We'll set this later
    });
    
    // Create the new UserPool with self sign-up and email/phone support
    // Pass the user profiles table to enable user profile creation on phone OTP verification
    const authentication = new NewAuthorizationStack(this, getResourceName("NewAuthorization"), {
      userProfilesTable: chatbotAPI.userProfilesTable,
      // The auth session table holds live Cognito refresh tokens for every
      // signed-in family, so it is encrypted with the same application CMK as
      // the IEP documents rather than an AWS-managed key.
      kmsKey: chatbotAPI.kmsKey
    });
    
    // Update the chatbot API with the authentication
    chatbotAPI.setAuthentication(authentication);
    
    const userInterface = new UserInterface(this, getResourceName("UserInterface"),
     {userPoolId : authentication.userPool.userPoolId,
      userPoolClientId : authentication.userPoolClient.userPoolClientId,
      cognitoDomain : getResourceName(cognitoDomainName) + '-new',
      api : chatbotAPI
    });
    
    // Update callback URLs for Cognito User Pool Client after CloudFront distribution is created
    const cfnUserPoolClient = authentication.userPoolClient.node.defaultChild as cdk.aws_cognito.CfnUserPoolClient;
    cfnUserPoolClient.callbackUrLs = [
      ...cfnUserPoolClient.callbackUrLs || [],
      `https://${userInterface.websiteDistribution.distributionDomainName}`
    ];
    cfnUserPoolClient.logoutUrLs = [
      ...cfnUserPoolClient.logoutUrLs || [],
      `https://${userInterface.websiteDistribution.distributionDomainName}`
    ];
    
    // Apply tags to all resources in the stack
    applyTags(this);
  }
}
