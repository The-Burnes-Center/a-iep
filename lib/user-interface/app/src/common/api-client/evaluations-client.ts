import { Utils } from "../utils";
import { AppConfig } from "../types";

export class EvaluationsClient {
  private readonly API;
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  // Fetch evaluation summaries
  async getEvaluationSummaries(continuationToken?: unknown, limit: number = 10, testCaseFileName?: string) {
    const auth = await Utils.authenticate();
    console.log("auth eval: ", auth)
    const body: {
      operation: string;
      limit: number;
      continuation_token?: unknown;
      test_case_file_name?: string;
    } = {
      operation: "get_evaluation_summaries",
      limit,
    };
    if (continuationToken) { 
      body.continuation_token = continuationToken;
    }
    if (testCaseFileName) {
      body.test_case_file_name = testCaseFileName; // Include the test case filename
    }

    const response = await fetch(`${this.API}/eval-results-handler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(body),
    });
    console.log("response eval: ", response)
    if (!response.ok) {
      throw new Error("Failed to get evaluation summaries");
    }

    const result = await response.json();
    return result;
  }

  // Fetch detailed evaluation results
  async getEvaluationResults(evaluationId: string, continuationToken?: unknown, limit: number = 10) {
    const auth = await Utils.authenticate();
    const body: {
      operation: string;
      evaluation_id: string;
      limit: number;
      continuation_token?: unknown;
    } = {
      operation: "get_evaluation_results",
      evaluation_id: evaluationId,
      limit,
    };
    if (continuationToken) {
      body.continuation_token = continuationToken;
    }

    const response = await fetch(`${this.API}/eval-results-handler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error("Failed to get evaluation results");
    }

    const result = await response.json();
    return result;
  }
  async startNewEvaluation(evaluationName: string, testCaseFile: string) {
    const auth = await Utils.authenticate();
    const body = {
      // operation: "start_new_evaluation",
      evaluation_name: evaluationName,
      testCasesKey: testCaseFile,
    };
    const response = await fetch(`${this.API}/eval-run-handler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(body), 
    });
    if (!response.ok) {
      throw new Error("Failed to start new evaluation");
    }

    const result = await response.json();
    return result;
  }

    // Generalized method to get signed URLs for upload or download
  async getSignedURL(
    fileName: string,
    operation: 'upload' | 'download',
    fileType?: string
  ): Promise<string> {
    if (operation === 'upload' && !fileType) {
      alert('Must have valid file type for upload!');
      return;
    }

    try {
      const auth = await Utils.authenticate();
      const response = await fetch(this.API + '/signed-url-test-cases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
        },
        body: JSON.stringify({ fileName, fileType, operation }),
      });

      if (!response.ok) {
        throw new Error('Failed to get signed URL');
      }

      const data = await response.json();
      return data.signedUrl;
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }
  }

  async getUploadURL(fileName: string, fileType: string): Promise<string> {
    return this.getSignedURL(fileName, 'upload', fileType);
  }

  async getDownloadURL(fileName: string): Promise<string> {
    return this.getSignedURL(fileName, 'download');
  }

  // Returns a list of documents in the S3 bucket (hard-coded on the backend)
  async getDocuments(continuationToken?: string, pageIndex?: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/s3-test-cases-bucket-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization' : auth
      },
      body: JSON.stringify({
        continuationToken: continuationToken,
        pageIndex: pageIndex,
      }),
    });
    if (!response.ok) {
      throw new Error('Failed to get files');
    }
    const result = await response.json();
    return result;
  }
}
