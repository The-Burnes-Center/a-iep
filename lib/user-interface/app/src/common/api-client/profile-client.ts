import { Utils } from "../utils";
import { AppConfig, UserProfile, ChildResponse, ChildSurvey, SurveySave, SurveyRecord } from "../types";

/**
 * A baseline save after the summary was opened (409 baseline_closed). Not a
 * failure to show as one: the screen thanks the parent and moves on.
 */
export class SurveyClosedError extends Error {
  constructor() {
    super('The baseline closed when the summary was opened');
    this.name = 'SurveyClosedError';
  }
}

export class ProfileClient {
  private readonly API;
  
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  async getProfile(): Promise<UserProfile> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/profile`, {
      method: 'GET',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Service unavailable');
    }
    
    const data = await response.json();
    return data.profile;
  }

  async updateProfile(profile: Partial<UserProfile>): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/profile`, {
      method: 'PUT',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(profile)
    });

    if (!response.ok) {
      throw new Error('Failed to update profile');
    }
  }

  async addChild(name: string, schoolCity: string): Promise<ChildResponse> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/profile/children`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ name, schoolCity })
    });

    if (!response.ok) {
      throw new Error('Failed to add child');
    }

    return response.json();
  }

  /**
   * Change one child's name or school, touching no other child. PUT /profile
   * replaces the whole list, so it is the wrong tool once there is more than
   * one child.
   */
  async updateChild(childId: string, changes: { name?: string; schoolCity?: string }): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/profile/children/${encodeURIComponent(childId)}`, {
      method: 'PUT',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(changes)
    });

    if (!response.ok) {
      throw new Error('Failed to update child');
    }
  }

  /**
   * Remove one child and permanently delete their IEPs and summaries. The
   * server refuses to remove the only child, and keeps the child if their
   * documents could not be deleted, so a failure can always be retried.
   */
  async removeChild(childId: string): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/profile/children/${encodeURIComponent(childId)}`, {
      method: 'DELETE',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to remove child');
    }
  }

  async deleteProfile(): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/profile`, {
      method: 'DELETE',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to delete profile');
    }
  }

  private surveyPath(childId: string): string {
    return `${this.API}/profile/children/${encodeURIComponent(childId)}/survey`;
  }

  /** This child's survey and the household's. Throws on any non-2xx. */
  async getSurvey(childId: string): Promise<ChildSurvey> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.surveyPath(childId), {
      method: 'GET',
      mode: 'cors',
      headers: { 'Authorization': 'Bearer ' + auth, 'Accept': 'application/json' }
    });
    if (!response.ok) {
      throw new Error('Failed to load survey');
    }
    return response.json();
  }

  /**
   * Save one phase; the answers sent replace that phase's answers. Throws
   * SurveyClosedError for a baseline save after the summary was opened.
   */
  async saveSurvey(childId: string, save: SurveySave): Promise<SurveyRecord> {
    const auth = await Utils.authenticate();
    const response = await fetch(this.surveyPath(childId), {
      method: 'PUT',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(save)
    });
    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      if (body?.code === 'baseline_closed') throw new SurveyClosedError();
    }
    if (!response.ok) {
      throw new Error('Failed to save survey');
    }
    const body = await response.json();
    return body[save.phase];
  }

  /** Record that this child's summary was opened. Idempotent on the server. */
  async markSummaryViewed(childId: string): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.surveyPath(childId)}/summary-viewed`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Authorization': 'Bearer ' + auth, 'Accept': 'application/json' }
    });
    if (!response.ok) {
      throw new Error('Failed to record the summary view');
    }
  }
}
