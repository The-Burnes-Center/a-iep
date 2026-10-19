import { getResourceName } from './tags';

// Base names for resources (without environment suffixes)
const baseCognitoDomainName = "a-iep";
const baseStackName = "AIEPStack";

// Export the environment-specific names
export const cognitoDomainName = getResourceName(baseCognitoDomainName, 'cognito');
export const stackName = getResourceName(baseStackName, 'stack');

export const AUTHENTICATION = true;

// change these as needed
// must be unique globally or the deployment will fail
export const OIDCIntegrationName = ""
// this can be anything that would be understood easily, but you must use the same name
// when setting up a sign-in provider in Cognito
// make sure to leave it blank if you do not actually have an SSO provider configured in Cognito! 

// S3 lifecycle windows. Incomplete multipart uploads are aborted after a week.
// The website bucket keeps superseded object versions for a month. Neither
// expires current objects.
export const MULTIPART_UPLOAD_ABORT_DAYS = 7;
export const WEBSITE_NONCURRENT_VERSION_DAYS = 30;
