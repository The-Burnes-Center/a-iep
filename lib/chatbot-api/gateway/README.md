# API Gateway Components

This directory contains the implementation of the AWS API Gateway configuration for the AI-IEP system. It provides the REST API that serves as the interface between the frontend application and the backend Lambda functions.

## Overview

The API Gateway component provides a HTTP-based API for stateless, request-response interactions between the frontend and backend services.

## REST API (rest-api.ts)

The REST API provides HTTP endpoints for the AI-IEP application, handling authentication and routing to various Lambda functions.

### Implementation Details

The REST API is implemented in `rest-api.ts` using the AWS CDK `HttpApi` construct from the AWS API Gateway v2 package. Key features include:

- Configured with CORS support for browser access
- JWT authorization using Cognito User Pools
- Integration with Lambda functions via HTTP Lambda integrations
- Default route configurations

### API Endpoints

The following endpoints are configured in the main ChatBotApi stack:

- `/s3-knowledge-bucket-data` (POST): Retrieve documents from S3
- `/delete-s3-file` (POST): Delete documents from S3
- `/signed-url-knowledge` (POST): Generate presigned URLs for S3 uploads
- `/profile` (GET, PUT, DELETE): User profile management and deletion
- `/profile/children` (POST): Add children to user profiles
- `/profile/children/{childId}/documents` (GET, DELETE): Manage child documents

`/documents/{iepId}/status` (GET) and `/summary` (POST) are declared in
`chatbot-api/index.ts` but the profile handler registers neither, so both 404
through `RouteNotFoundException`. They are listed here only so the next person
does not go looking for the handler.

### Security Features

- JWT authorization for all endpoints
- CORS configuration for frontend access
- HTTPS enforcement
- Token validation

### Usage Example

```typescript
// Adding a new route to the REST API
restBackend.restAPI.addRoutes({
  path: "/new-endpoint",
  methods: [apigwv2.HttpMethod.POST],
  integration: newLambdaIntegration,
  authorizer: httpAuthorizer,
});
```

## Development Guidelines

### Adding New REST API Endpoints

1. **Define the Lambda Integration**:
   ```typescript
   const newIntegration = new HttpLambdaIntegration('NewIntegration', lambdaFunction);
   ```

2. **Add the Route**:
   ```typescript
   restAPI.addRoutes({
     path: "/new-path",
     methods: [HttpMethod.GET],
     integration: newIntegration,
     authorizer: httpAuthorizer
   });
   ```

3. **Update CORS if needed**:
   ```typescript
   // Check existing CORS configuration in rest-api.ts
   ```

## Security Considerations

- All REST API endpoints should use JWT authorization
- CORS settings should be restrictive
- Use HTTPS for all communications
- Implement throttling to prevent abuse

## Testing API Endpoints

1. **Using API Gateway Console**:
   - Navigate to API Gateway in AWS Console
   - Select the API
   - Use the "Test" feature for endpoints

2. **Using Postman or similar tools**:
   - Create a collection for API endpoints
   - Set up authentication headers
   - Test each endpoint with valid and invalid data 