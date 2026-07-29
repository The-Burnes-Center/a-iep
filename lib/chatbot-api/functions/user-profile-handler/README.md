# User Profile Handler

This Lambda function handles user profile management, child information management, and document association for the AI-IEP system. It provides RESTful API endpoints through API Gateway for managing user data and related IEP documents.

## Overview

The User Profile Handler manages the following core functionality:

1. **User Profile Management**: Create, retrieve, and update user profiles
2. **Child Management**: Add and manage children associated with user accounts
3. **Document Management**: Associate IEP documents with children and users
4. **Document Status**: Retrieve document processing status
5. **Profile Creation**: Automatically create profiles for new Cognito users

## Architecture

```
API Gateway → Lambda Function → DynamoDB
   ↓
Cognito User Pool → Trigger → Lambda Function → DynamoDB
```

## Components

### Main Handler (lambda_function.py)

The main Lambda handler implements a REST API with the following endpoints:

- **GET /profile**: Retrieves a user's profile
- **PUT /profile**: Updates a user's profile information
- **DELETE /profile**: Deletes the entire user profile and all associated data
- **POST /profile/children**: Adds a child to a user's profile
- **GET /profile/children/{childId}/documents**: Gets documents for a specific child
- **DELETE /profile/children/{childId}/documents/{documentId}**: Deletes a document
- **GET /documents/{iepId}/status**: Retrieves the processing status of a document
- **POST /summary**: Generates or retrieves a document summary

### Cognito Trigger (cognito_trigger.py)

This module is triggered when a new user completes registration in Cognito. It:

1. Creates an initial user profile in DynamoDB
2. Associates Cognito user attributes with the profile
3. Sets up default preferences

### Router (router.py)

A custom routing module that:

1. Maps HTTP methods and paths to handler functions
2. Provides consistent error handling
3. Manages request parsing and response formatting

## Implementation Details

### User Profile Management

User profiles are created and managed through the following process:

1. **Profile Creation**:
   - Automatically created on Cognito user confirmation
   - Contains basic user information
   - Initialized with empty children array

2. **Profile Retrieval**:
   - Uses `userId` from Cognito JWT token
   - Returns complete profile with children information
   - Creates default profile if none exists

3. **Profile Updates**:
   - Supports partial updates (only specified fields)
   - Updates timestamps automatically
   - Validates field values (e.g., language codes)

### Child Management

Children are managed as nested objects within user profiles:

1. **Adding Children**:
   - Generates unique `childId`
   - Validates required fields (name, date of birth)
   - Updates user profile atomically

2. **Child Documents**:
   - Retrieved using GSI on IEP documents table
   - Filtered by `childId`
   - Returns document metadata (not content)

### Document Management

IEP documents are managed through:

1. **Document Retrieval**:
   - Queries the `byChildId` GSI
   - Returns document metadata sorted by creation date
   - Handles pagination for multiple documents

2. **Document Deletion**:
   - Removes document from S3 bucket
   - Deletes metadata from DynamoDB
   - Updates associated tables

## Error Handling

The function implements robust error handling:

1. **Input Validation**:
   - Validates required fields
   - Checks field formats and values
   - Returns appropriate error messages

2. **Authentication Errors**:
   - Validates JWT tokens
   - Ensures user can only access their own data
   - Handles expired or invalid tokens

3. **Database Errors**:
   - Graceful handling of DynamoDB errors
   - Retries for transient issues
   - Consistent error responses

4. **Logging**:
   - Detailed error logging to CloudWatch
   - Includes request context for debugging
   - Masks sensitive information

## Configuration

### Environment Variables

- `USER_PROFILES_TABLE`: DynamoDB table for user profiles
- `IEP_DOCUMENTS_TABLE`: DynamoDB table for IEP document metadata
- `BUCKET`: S3 bucket for IEP documents
- `USER_POOL_ID`: Cognito User Pool ID for user account deletion

### Permissions

The Lambda function requires:

- DynamoDB read/write access to user profiles table
- DynamoDB read/write access to IEP documents table
- S3 read/delete access to documents bucket
- Cognito admin permissions for user deletion (`cognito-idp:AdminDeleteUser`)

## Development Guidelines

When modifying this component:

1. **Adding New Endpoints**:
   - Update the router in `router.py`
   - Implement handler function in `lambda_function.py`
   - Add appropriate error handling

2. **Modifying Data Model**:
   - Update validation logic for new fields
   - Ensure backward compatibility
   - Update access patterns if needed

3. **Performance Optimization**:
   - Use appropriate DynamoDB query patterns
   - Limit response sizes as needed
   - Consider pagination for large responses

## Testing

For testing this component:

1. **API Testing**:
   - Test each endpoint with valid inputs
   - Test error cases and edge conditions
   - Verify authorization controls

2. **Integration Testing**:
   - Test interactions with Cognito
   - Test interactions with document processing
   - Verify end-to-end workflows

## Security Considerations

- All requests require JWT authorization
- Users can only access their own profiles and documents
- Data is validated before storage
- No sensitive information is logged
- CORS is configured for frontend access

## User Identity Management

User identity information (email, etc.) is managed exclusively through Amazon Cognito:
- Email addresses are stored and managed in Cognito User Pool
- Email verification and updates must be done through Cognito
- Applications should retrieve email from Cognito tokens/claims
- Profile data focuses on application-specific information only

## Database Schema

### UserProfilesTable
```typescript
{
  userId: string,           // Partition key (from Cognito)
  phone: string,           // User's phone number (optional)
  primaryLanguage: string, // Primary language preference
  secondaryLanguage?: string, // Optional secondary language
  city: string,           // User's city of residence
  consentGiven: boolean,    // User's consent status (defaults to false)
  showOnboarding: boolean,  // Whether to show onboarding flow (defaults to true)
  children: [                 // Array of children
    {
      childId: string,      // Unique identifier for child
      name: string,       // Child's name
      schoolCity: string,  // City where child attends school
      iepDocument: {        // Most recent IEP document for this child
        iepId: string,      // Unique document ID
        documentUrl: string, // S3 URL to the document
        updatedAt: string    // Last update timestamp
      }
    }
  ],
  createdAt: number,      // Creation timestamp
  updatedAt: number,      // Last update timestamp
  ttl?: number           // Optional TTL for record expiration
}
```

### IepDocumentsTable
```typescript
{
  iepId: string,          // Partition key
  childId: string,          // Sort key
  userId: string,         // Owner's user ID
  documentUrl: string,    // S3 URL to the document
  summaries: {            // Document summaries in different languages
    [languageCode: string]: string
  },
  sections: {             // Document sections in different languages
    [languageCode: string]: {
      [sectionTitle: string]: string
    }
  },
  status: string,         // Document processing status (PROCESSING, PROCESSED, FAILED, OCR_COMPLETED, OCR_FAILED)
  ocrData: {              // OCR extraction data from Mistral API
    pages: [              // Array of pages with extracted text
      {
        index: number,    // Page index (0-based)
        markdown: string, // Extracted text in markdown format
        images: any[],    // Any images found in the document
        dimensions: {     // Page dimensions
          dpi: number,    // Dots per inch
          height: number, // Page height
          width: number   // Page width
        }
      }
    ],
    model: string,        // Model used for OCR (e.g., "mistral-ocr-2503-completion")
    usage: {              // Usage statistics 
      pages_processed: number,    // Number of pages processed
      document_size_bytes: number // Document size in bytes
    },
    success: boolean      // Whether OCR processing was successful
  },
  ocrCompletedAt: string, // ISO timestamp when OCR processing completed
  createdAt: number,      // Creation timestamp
  updatedAt: number,      // Last update timestamp
  ttl?: number           // Optional TTL for record expiration
}
```

## File Upload Process

### 1. Get Upload URL
```http
POST /signed-url-knowledge
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "fileName": "string",
  "fileType": "string",
  "operation": "upload",
  "childId": "string"
}
```

**Response (200)**
```json
{
  "signedUrl": "string",    // Pre-signed S3 URL for upload
  "iepId": "string",        // Unique document ID
  "documentUrl": "string"   // S3 URL where document will be stored
}
```

### 2. File Storage Structure
Files are stored in S3 with the following path structure:
```
s3://<bucket>/<userId>/<childId>/<iepId>/<fileName>
```

### 3. Document Processing
After upload:
1. Document record is created in IepDocumentsTable (replacing any existing documents for that child)
2. Automatic processing begins for generating summaries
3. Status is tracked and can be monitored via API

**Note**: Each child can only have one active IEP document at a time. When a new document is uploaded, any existing document for that child is automatically deleted and replaced with the new one.

## API Endpoints

### 1. Get User Profile
```http
GET /profile
Authorization: Bearer <jwt-token>
```
Returns the user's profile information. Creates a default profile if none exists.

**Response (200)**
```json
{
  "profile": {
    "userId": "string",
    "phone": "string",
    "primaryLanguage": "string",
    "secondaryLanguage": "string",
    "city": "string",
    "consentGiven": boolean,
    "showOnboarding": boolean,
    "children": [
      {
        "childId": "string",
        "name": "string",
        "schoolCity": "string"
      }
    ],
    "createdAt": number,
    "updatedAt": number
  }
}
```

### 2. Update User Profile
```http
PUT /profile
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "phone": "string",
  "primaryLanguage": "string",
  "secondaryLanguage": "string",
  "city": "string",
  "consentGiven": boolean,
  "showOnboarding": boolean,
  "children": [
    {
      "childId": "string",
      "name": "string",
      "schoolCity": "string"
    }
  ]
}
```

**Note**: Email updates must be performed through Cognito user management, not through this API. The consentGiven and showOnboarding fields must be valid JSON boolean values (true or false, lowercase without quotes).

**Response (200)**
```json
{
  "message": "Profile updated successfully"
}
```

**Response (400) - Invalid boolean field type**
```json
{
  "message": "consentGiven must be a boolean value (true or false)"
}
```

**Response (400) - Invalid showOnboarding type**
```json
{
  "message": "showOnboarding must be a boolean value (true or false)"
}
```

### 3. Delete User Profile
```http
DELETE /profile
Authorization: Bearer <jwt-token>
```

Deletes the entire user profile and all associated data permanently. This operation:
1. Deletes all S3 files for the user (all folders under `userId/`)
2. Deletes all IEP document records in the database
3. Deletes the user profile record
4. Deletes the Cognito user account

**⚠️ WARNING: This operation is irreversible and will completely remove all user data.**

**Response (200)**
```json
{
  "message": "User profile and all associated data successfully deleted",
  "userId": "string",
  "deletionSummary": {
    "s3ObjectsDeleted": number,
    "documentsDeleted": number,
    "profileDeleted": boolean,
    "cognitoUserDeleted": boolean
  }
}
```

**Response (500)**
```json
{
  "message": "Error deleting user profile: [error details]"
}
```

### 4. Add Child
```http
POST /profile/children
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "name": "string",
  "schoolCity": "string"
}
```

**Response (200)**
```json
{
  "message": "Kid added successfully",
  "childId": "string",
  "createdAt": number,
  "updatedAt": number
}
```

### 4. Get Child's Documents
```http
GET /profile/children/{childId}/documents
Authorization: Bearer <jwt-token>
```

Query Parameters:
- `include_ocr` (optional): Boolean flag to include OCR data in response (default: true)

**Response (200) - Document Found**
```json
{
  "iepId": "string",
  "childId": "string",
  "documentUrl": "string",
  "status": "string",
  "summaries": {
    "en": "string",
    "es": "string",
    "zh": "string",
    "vi": "string"
  },
  "document_index": {
    "en": "string",
    "es": "string",
    "zh": "string",
    "vi": "string"
  },
  "abbreviations": {
    "en": [
      {
        "abbreviation": "IEP",
        "full_form": "Individualized Education Program"
      }
    ],
    "es": [
      {
        "abbreviation": "IEP",
        "full_form": "Programa de Educación Individualizada"
      }
    ],
    "zh": [...],
    "vi": [...]
  },
  "sections": {
    "en": {
      "section1": "string",
      "section2": "string"
    }
  },
  "createdAt": number,
  "updatedAt": number
}
```

**Response (200) - No Document Found**
```json
{
  "documents": [],
  "message": "No document found for this child"
}
```

**Note**: Only the most recent document for a child is returned. When a new document is uploaded for a child, any existing documents for that child are automatically deleted.

### 5. Delete Child's IEP Documents
```http
DELETE /profile/children/{childId}/documents
Authorization: Bearer <jwt-token>
```

Deletes all IEP-related data for a specific child, including:
1. All IEP documents stored in S3
2. All IEP document records in the database
3. IEP document references in the user's profile

This operation does not delete the child's profile information, only their IEP-related data.

**S3 Deletion Process:**
- The operation identifies all S3 objects with the prefix `{userId}/{childId}/`
- Each object is individually deleted from the S3 bucket
- The process is resilient: if S3 deletion fails, the function will still attempt to clean up database records

**Response (200)**
```json
{
  "message": "IEP documents successfully deleted",
  "childId": "string"
}
```

**Response (500)**
```json
{
  "message": "Error deleting IEP documents: [error details]"
}
```

## Language Support

The system supports the following languages:
- English (en) - Default
- Chinese (zh)
- Spanish (es)
- Vietnamese (vi)
- Arabic (ar)

## Error Handling

All endpoints return appropriate HTTP status codes:
- 200: Success
- 400: Bad Request (invalid input)
- 401: Unauthorized (invalid/missing token)
- 403: Forbidden (accessing unauthorized resource)
- 404: Not Found (endpoint not found)
- 500: Internal Server Error

Error responses include a message:
```json
{
  "message": "Error description"
}
```

## Security