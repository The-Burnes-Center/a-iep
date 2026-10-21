import {
  Utils
} from "../utils"

import { AppConfig } from "../types";

export class KnowledgeManagementClient {

  private readonly API;
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0,-1);
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
      const response = await fetch(this.API + '/signed-url-knowledge', {
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

  // Runs a sync job on Kendra (hardcoded datasource as well as index on the backend)
  async syncKendra() : Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/kb-sync/sync-kb', {headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
    }})
    if (!response.ok) {
      throw new Error('Failed to sync');
    }
    return await response.json()
  }

  // Checks if Kendra is currently syncing (used to disable the sync button)
  async kendraIsSyncing() : Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/kb-sync/still-syncing', {headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
    }})
    if (!response.ok) {
      throw new Error('Failed to check sync status');
    }
    return await response.json()
  }

  // Checks the last time Kendra was synced
  async lastKendraSync() : Promise<string> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/kb-sync/get-last-sync', {headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
    }})
    if (!response.ok) {
      throw new Error('Failed to check last status');
    }
    return await response.json()
  }

  // get's the current system prompt
  async getCurrentSystemPrompt() {
    const auth = await Utils.authenticate();
    console.log("auth sys prompt: ", auth)
    const response = await fetch(this.API + '/system-prompts-handler', {
      method: 'POST',
      headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
      },
      body: JSON.stringify({
        "operation": "get_active_prompt"
      })
    })
    console.log("response in the api: ", response)
    if (!response.ok) {
      throw new Error('Failed to get system prompt');
    }
    return await response.json()
  }

  // Sets the system prompt by adding a new prompt into the ddb table
  async setSystemPrompt(prompt: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/system-prompts-handler', {
      method: 'POST',
      headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
      },
      body: JSON.stringify({
        "operation": "set_prompt",
        "prompt": prompt
      })
    })
    if (!response.ok) {
      throw new Error('Failed to set system prompt');
    }
    return await response.json()
  }

  async stageSystemPrompt(prompt: string) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/system-prompts-handler', {
      method: 'POST',
      headers: {
      'Content-Type': 'application/json',
      'Authorization' : auth
      },
      body: JSON.stringify({
        "operation": "stage_prompt",
        "prompt": prompt
      })
    })
    console.log("response in the api: ", response)
    if (!response.ok) {
      throw new Error('Failed to stage system prompt');
    }
    return await response.json()
  }

  // Returns a list of system prompts and the timestamp they were uploaded as the active prompt
  async listStagedSystemPrompts(continuationToken?: string, pageIndex?: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/system-prompts-handler', {
      method: 'POST',
      headers: {
      'Content-Type': 'application/json', 
      'Authorization' : auth
      },
      body: JSON.stringify({
        "operation": "get_staged_prompts",
        continuationToken: continuationToken,
        pageIndex: pageIndex,
      })
    })
    if (!response.ok) {
      throw new Error('Failed to list system prompts');
    }
    return await response.json()
  }

  async listActiveSystemPrompts(continuationToken?: string, pageIndex?: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/system-prompts-handler', {
      method: 'POST',
      headers: {
      'Content-Type': 'application/json', 
      'Authorization' : auth
      },
      body: JSON.stringify({
        "operation": "get_active_prompts",
        continuationToken: continuationToken,
        pageIndex: pageIndex,
      })
    })
    if (!response.ok) {
      throw new Error('Failed to list system prompts');
    }
    return await response.json()
  }

  
}
