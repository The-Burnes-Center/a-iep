import { Utils } from "../utils";
import { AppConfig, AdminUser, ReferralLink, ReferralStats } from "../types";

export interface CampaignLinkInput {
  code: string;
  name?: string;
  channel?: string;
  notes?: string;
}

export interface CampaignLinkUpdate {
  name?: string;
  channel?: string;
  notes?: string;
  active?: boolean;
}

export class ReferralClient {
  private readonly API;

  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  /**
   * Public click beacon: fire-and-forget, unauthenticated. sendBeacon
   * delivers even though the capture route navigates away immediately; the
   * fetch fallback stays a "simple" CORS request (no preflight) because it
   * sets no Content-Type header.
   */
  logClick(code: string): void {
    const url = `${this.API}/referral/click`;
    const payload = JSON.stringify({ code });
    try {
      if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, payload)) {
        return;
      }
    } catch {
      // fall through to fetch
    }
    fetch(url, { method: 'POST', mode: 'cors', keepalive: true, body: payload }).catch(() => {});
  }

  async getMyReferral(): Promise<ReferralStats> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/me`, {
      method: 'GET',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error('Service unavailable');
    }
    return response.json();
  }

  async attribute(code: string): Promise<{ attributed: boolean; reason?: string }> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/attribute`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ code })
    });
    if (!response.ok) {
      throw new Error('Failed to record referral');
    }
    return response.json();
  }

  async adminListLinks(): Promise<ReferralLink[]> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/admin/links`, {
      method: 'GET',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(response.status === 403 ? 'Not authorized' : 'Service unavailable');
    }
    const data = await response.json();
    return data.links;
  }

  async adminCreateLink(input: CampaignLinkInput): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/admin/links`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(input)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.message || 'Failed to create link');
    }
  }

  async adminListAdmins(): Promise<AdminUser[]> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/admin/admins`, {
      method: 'GET',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error('Service unavailable');
    }
    const data = await response.json();
    return data.admins;
  }

  /** Add an admin by phone number or email; the backend resolves the account. */
  async adminAddAdmin(identifier: string): Promise<AdminUser> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/admin/admins`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ identifier })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.message || 'Failed to add admin');
    }
    return data.admin;
  }

  async adminRemoveAdmin(username: string): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/admin/admins/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.message || 'Failed to remove admin');
    }
  }

  async adminUpdateLink(code: string, updates: CampaignLinkUpdate): Promise<void> {
    const auth = await Utils.authenticate();
    const response = await fetch(`${this.API}/referral/admin/links/${encodeURIComponent(code)}`, {
      method: 'PUT',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(updates)
    });
    if (!response.ok) {
      throw new Error('Failed to update link');
    }
  }
}
