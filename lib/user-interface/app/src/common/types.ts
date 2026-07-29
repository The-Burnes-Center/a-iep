import { SupportedLanguage } from "./languages";

export interface AppConfig {
  Auth: {
        region: string,
        userPoolId: string,
        userPoolWebClientId: string,
        oauth: {
          domain: string,
          scope: string[],
          redirectSignIn: string,
          // redirectSignOut: "https://myapplications.microsoft.com/",
          responseType: string,
        }
      },
      httpEndpoint : string,
      wsEndpoint : string,
      federatedSignInProvider : string,
      // Languages offered in this environment. Set per environment at
      // build/deploy time (e.g. Arabic is enabled on dev but not prod).
      // Optional: when absent the UI falls back to all supported languages.
      enabledLanguages? : SupportedLanguage[],
      // Deployment environment, set by CDK. Gates prod-only integrations
      // (Google Analytics). Absent on local dev configs, which disables them.
      environment? : "prod" | "dev",
}

export interface NavigationPanelState {
  collapsed?: boolean;
  collapsedSections?: Record<number, boolean>;
}

export type LoadingStatus = "pending" | "loading" | "finished" | "error";
export type AdminDataType =
| "file"
| "feedback"
| "evaluationSummary"
| "detailedEvaluation"
| "prompt";

// In src/common/types.ts
export interface Child {
  childId?: string;
  name: string;
  schoolCity: string;
}

export interface UserProfile {
  userId: string;
  email: string;
  phone: string;
  primaryLanguage: string;
  secondaryLanguage: string;
  city: string;
  parentName: string;
  children: Child[];
  createdAt: number;
  updatedAt: number;
  consentGiven: boolean;
  showOnboarding: boolean;
  // Referral system: this user's own shareable code, and the code they
  // arrived on (stamped once at signup, never overwritten)
  referralCode?: string;
  referredBy?: string;
}

export interface ReferralJoin {
  joinedAt: string;
}

export interface ReferralStats {
  code: string;
  clicks: number;
  signups: number;
  joins: ReferralJoin[];
}

export interface ReferralLink {
  code: string;
  type: 'campaign' | 'user';
  name?: string;
  channel?: string;
  notes?: string;
  active: boolean;
  clicks: number;
  signups: number;
  createdAt?: string;
  ownerUserId?: string;
  // Parent's name for user-type links, resolved server-side for admins only
  ownerName?: string;
}

export interface AdminUser {
  username: string;
  sub?: string;
  phone?: string;
  email?: string;
  name?: string;
  status?: string;
}

export interface Language {
  primaryLanguage: string;
  secondaryLanguage: string;
}

export interface ProfileResponse {
  profile: UserProfile;
}

export interface ChildResponse {
  message: string;
  childId: string;
  createdAt: number;
  updatedAt: number;
}

// Add to types.ts
export interface IEPSection {
  name: string;
  displayName: string;
  content: string;
  pageNumbers?: number[];
}

export interface IEPDocument {
  // Basic document info
  documentId?: string;
  documentUrl?: string;
  status?: "PROCESSING" | "PROCESSING_TRANSLATIONS" | "PROCESSED" | "FAILED";
  progress?: number; // Processing progress percentage (0-100)
  current_step?: string; // Current processing step (e.g., "initializing", "ocr_complete", "redacting", etc.)
  createdAt?: number; // Unix timestamp (seconds since epoch)
  updatedAt?: number; // Unix timestamp (seconds since epoch)
  message?: string;
  
  // Document content by language
  abbreviations?: {
    en?: Array<{
      abbreviation: string;
      full_form: string;
    }>;
  };
  summaries: {
    en?: string;
    vi?:string;
    es?: string;
    zh?: string;
    ar?: string;
    // Add other languages as needed
  };

  // Document index (Table of Contents)
  document_index: {
    en?: string;
    vi?: string;
    es?: string;
    zh?: string;
    ar?: string;
    // Add other languages as needed
  };

  sections: {
    en: IEPSection[];
    vi: IEPSection[];
    es: IEPSection[];
    zh: IEPSection[];
    ar: IEPSection[];
    // Add other languages as needed
  };

  // Raw data
  ocrData?: unknown;
}