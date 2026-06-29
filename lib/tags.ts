import * as cdk from 'aws-cdk-lib';
import { Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export type Environment = 'dev' | 'prod';

export function getEnvironment(): Environment {
  const env = process.env.ENVIRONMENT || process.env.NODE_ENV;
  if (env === 'production' || env === 'prod') return 'prod';
  return 'dev';
}

/**
 * Get environment-specific resource name
 * @param baseName The base name of the resource
 * @param resourceType Optional resource type for specific naming patterns
 * @returns The environment-specific resource name
 */
export function getResourceName(baseName: string, resourceType?: 'stack' | 'cognito'): string {
  const env = getEnvironment();

  if (env === 'dev') {
    if (resourceType === 'stack' && baseName.endsWith('Stack')) {
      const baseWithoutStack = baseName.replace('Stack', '');
      return `${baseWithoutStack}StagingStack`;
    }
    return `${baseName}-staging`;
  }

  return baseName;
}

/**
 * Standard tags to apply to all resources in the stack
 */
export const STANDARD_TAGS = {
  Project: 'a-iep',
  Environment: getEnvironment(),
  ManagedBy: 'cdk',
  Owner: 'burnes-center',
};

/**
 * Apply standard tags to an entire construct and all its children
 * 
 * @param scope The construct to tag
 * @param additional Additional tags to apply (optional)
 */
export function applyTags(scope: Construct, additional?: Record<string, string>): void {
  const allTags = { ...STANDARD_TAGS, ...additional };
  
  Object.entries(allTags).forEach(([key, value]) => {
    Tags.of(scope).add(key, value);
  });
}

/**
 * Generate tag props for direct use in resource creation
 * 
 * @param additional Additional tags to apply (optional)
 * @returns Tag props for AWS resources
 */
export function getTagProps(additional?: Record<string, string>): { [key: string]: string } {
  return { ...STANDARD_TAGS, ...additional };
}

/**
 * Apply tags to a specific resource
 * 
 * @param resource The resource to tag
 * @param additional Additional tags to apply (optional)
 */
export function tagResource(resource: cdk.Resource, additional?: Record<string, string>): void {
  const allTags = { ...STANDARD_TAGS, ...additional };
  
  Object.entries(allTags).forEach(([key, value]) => {
    cdk.Tags.of(resource).add(key, value);
  });
} 