// iep-document-client.ts
import { Utils } from "../utils";
import { AppConfig } from "../types";
import { ProfileClient } from "./profile-client";

export interface DocumentAudioResponse {
  status: string;
  url: string;
  expiresInSeconds: number;
  cached: boolean;
  provider: string;
}

export interface TranslationRequestResponse {
  /** Document status after the call: PROCESSING_TRANSLATIONS (202) or PROCESSED (200). */
  status: string;
  language: string;
  iepId: string;
  /** True when the backend already held this translation and did no work (200). */
  alreadyExists: boolean;
  /** 202 (generation started) or 200 (nothing to do) — the caller reacts differently. */
  httpStatus: number;
}

/**
 * A non-2xx answer from the translations endpoint.
 *
 * The status code is carried separately so the caller can tell 403 (not your
 * document) from 409 (nothing to translate yet, or a translation already in
 * flight) and map each to its own message. The server's own body is
 * deliberately NOT surfaced: those strings are generic by design and the repo
 * does not leak causes to callers, so the UI must translate the code itself.
 */
export class TranslationRequestError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Translation request failed with status ${httpStatus}`);
    this.name = 'TranslationRequestError';
  }
}

export class IEPDocumentClient {
  private readonly API;
  private profileClient: ProfileClient;
  
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
    this.profileClient = new ProfileClient(_appConfig);
  }
  
  // Get the childId from the first child in the profile
  private async getDefaultChildId(): Promise<string> {
    const profile = await this.profileClient.getProfile();
    
    // If no children exist, create a default child automatically
    if (!profile.children || profile.children.length === 0) {
      // console.log('No children found in profile, creating default child for IEP document functionality');
      
      try {
        // Create a default child
        const childResponse = await this.profileClient.addChild('My Child', 'Not specified');
        // console.log('Successfully created default child:', childResponse.childId);
        return childResponse.childId;
      } catch (error) {
        // console.error('Failed to create default child:', error);
        throw new Error('No children found in profile and failed to create default child');
      }
    }
    
    return profile.children[0].childId;
  }
  
  // Get signed URL for upload/download
  async getSignedURL(
    fileName: string,
    operation: 'upload' | 'download',
    fileType?: string
  ): Promise<{ signedUrl: string }> {
    if (operation === 'upload' && !fileType) {
      throw new Error('File type is required for upload');
    }

    const childId = await this.getDefaultChildId();
    const auth = await Utils.authenticate();

    const response = await fetch(this.API + '/signed-url-knowledge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + auth,
      },
      body: JSON.stringify({
        fileName,
        fileType,
        operation,
        childId
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to get signed URL');
    }

    const data = await response.json();
    return data;
  }

  // Get URL for uploading a file
  async getUploadURL(fileName: string, fileType: string): Promise<string> {
    const response = await this.getSignedURL(fileName, 'upload', fileType);
    return response.signedUrl;
  }

  // Get most recent processed document with its summary and sections
  async getMostRecentDocumentWithSummary() {
    const childId = await this.getDefaultChildId();
    const auth = await Utils.authenticate();

    const response = await fetch(`${this.API}/profile/children/${childId}/documents`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + auth
      }
    });

    if (!response.ok) {
      throw new Error('Failed to get documents');
    }

    const result = await response.json();

    // If no document is found, return null
    if (!result || Object.keys(result).length === 0) {
      return null;
    }

    return result;
  }
  
  // Get (generating if needed) text-to-speech audio for a document's summary or a section.
  // The backend reads the canonical content server-side and returns a presigned MP3 URL.
  async getDocumentAudio(
    iepId: string,
    language: string,
    target: 'summary' | 'section',
    sectionName?: string
  ): Promise<DocumentAudioResponse> {
    const childId = await this.getDefaultChildId();
    const auth = await Utils.authenticate();
    const body = JSON.stringify({
      childId,
      language,
      target,
      ...(sectionName ? { sectionName } : {})
    });

    // A cold-cache synthesis can outlive the API Gateway 30s timeout while the
    // Lambda keeps running and caches the result, so a retry of the identical
    // request lands on the warm cache.
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response | null = null;
      try {
        response = await fetch(`${this.API}/documents/${iepId}/audio`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + auth
          },
          body
        });
      } catch {
        response = null; // network failure — treat like a timeout and retry
      }

      if (response) {
        if (response.ok) {
          return await response.json();
        }
        if (response.status !== 504) {
          let message = 'Failed to get document audio';
          try {
            const errorBody = await response.json();
            message = errorBody.message || message;
          } catch {
            // keep default message
          }
          throw new Error(message);
        }
      }

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    throw new Error('Timed out generating document audio');
  }

  // Ask the backend to translate an already-processed document into `language`.
  //
  // Like the audio route, this kicks off expensive server-side generation: the
  // 202 means the pipeline restarted at the translation step, and the document
  // poller (not this call) is what tells the UI when the content has landed.
  async requestTranslation(
    iepId: string,
    language: string
  ): Promise<TranslationRequestResponse> {
    const childId = await this.getDefaultChildId();
    const auth = await Utils.authenticate();

    const response = await fetch(
      `${this.API}/profile/children/${childId}/documents/${iepId}/translations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + auth
        },
        body: JSON.stringify({ language })
      }
    );

    if (!response.ok) {
      throw new TranslationRequestError(response.status);
    }

    let payload: Partial<TranslationRequestResponse> = {};
    try {
      payload = await response.json();
    } catch {
      // A 2xx with an unreadable body still means the request landed; fall back
      // to what we asked for rather than failing a started translation.
    }

    return {
      status: payload.status ?? '',
      language: payload.language ?? language,
      iepId: payload.iepId ?? iepId,
      alreadyExists: payload.alreadyExists ?? false,
      httpStatus: response.status
    };
  }

  // Delete a document
  async deleteFile(iepId: string) {
    const childId = await this.getDefaultChildId();
    const auth = await Utils.authenticate();

    const response = await fetch(`${this.API}/profile/children/${childId}/documents/${iepId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + auth
      }
    });

    if (!response.ok) {
      throw new Error('Failed to delete document');
    }

    return await response.json();
  }
}