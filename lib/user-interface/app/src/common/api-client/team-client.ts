import { createDirectus, rest, readItems } from '@directus/sdk';
import type { DirectusClient, RestClient } from '@directus/sdk';
import { AppConfig } from "../types";

// The splash-page content is managed in Directus, so extra fields may exist
// at runtime; only the fields the UI actually reads are typed here.
export interface TeamMember {
  id?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  thumbnail?: {
    filename_disk?: string;
  };
  [key: string]: unknown;
}

export interface SplashPageData {
  team?: TeamMember[];
  [key: string]: unknown;
}

type SplashPageSchema = {
  _aiep_splash_page: SplashPageData[];
};

export class TeamClient {
  private directus: DirectusClient<SplashPageSchema> & RestClient<SplashPageSchema>;

  constructor(protected _appConfig: AppConfig) {
    this.directus = createDirectus<SplashPageSchema>("https://directus.theburnescenter.org/").with(rest());
  }

  async getTeamMembersInfo(): Promise<SplashPageData> {
    const data = await this.directus.request<SplashPageData>(
      readItems<SplashPageSchema, "_aiep_splash_page", { limit: number; fields: string[] }>("_aiep_splash_page", {
        limit: -1,
        fields: ["*.*, team.*,team.thumbnail.*"]
      })
    );

    return data;
  }
}
