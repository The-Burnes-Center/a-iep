import { AppConfig } from "../types";
import { SessionsClient } from "./sessions-client";
import { KnowledgeManagementClient } from "./knowledge-management-client";
import { UserFeedbackClient } from "./user-feedback-client";
import { EvaluationsClient } from "./evaluations-client";
import { ProfileClient } from "./profile-client";
import { PDFClient } from "./pdf-client";
import { TeamClient } from "./team-client";
import { ReferralClient } from "./referral-client";

export class ApiClient {

  private _sessionsClient: SessionsClient | undefined;

  private _knowledgeManagementClient : KnowledgeManagementClient | undefined;
  private _userFeedbackClient: UserFeedbackClient | undefined;
  private _evaluationsClient: EvaluationsClient | undefined;
  private _profileClient: ProfileClient | undefined;
  private _pdfClient: PDFClient | undefined;
  private _teamClient: TeamClient | undefined;
  private _referralClient: ReferralClient | undefined;
 

  /** Construct the Knowledge Management sub-client */
  public get knowledgeManagement() {
    if (!this._knowledgeManagementClient) {
      this._knowledgeManagementClient = new KnowledgeManagementClient(this._appConfig);      
    }

    return this._knowledgeManagementClient;
  }

  public get profile() {
    if (!this._profileClient) {
      this._profileClient = new ProfileClient(this._appConfig);
    }
    return this._profileClient;
  }

  /** Construct the Sessions sub-client */
  public get sessions() {
    if (!this._sessionsClient) {
      this._sessionsClient = new SessionsClient(this._appConfig);
    }

    return this._sessionsClient;
  }


  /** Construct the Feedback sub-client */
  public get userFeedback() {
    if (!this._userFeedbackClient) {
      this._userFeedbackClient = new UserFeedbackClient(this._appConfig);
    }

    return this._userFeedbackClient;
  }

  /** Construct the Evaluations sub-client */
  public get evaluations() {
    if (!this._evaluationsClient) {
      this._evaluationsClient = new EvaluationsClient(this._appConfig);
    }

    return this._evaluationsClient;
  }

  /** Construct the PDF sub-client */
  public get pdf() {
    if (!this._pdfClient) {
      this._pdfClient = new PDFClient(this._appConfig);
    }

    return this._pdfClient;
  }

  /** Construct the Referral sub-client */
  public get referral() {
    if (!this._referralClient) {
      this._referralClient = new ReferralClient(this._appConfig);
    }
    return this._referralClient;
  }

  /** Construct the Team sub-client */
  public get team() {
    if (!this._teamClient) {
      this._teamClient = new TeamClient(this._appConfig);
    }

    return this._teamClient;
  }

  constructor(protected _appConfig: AppConfig) {}
}
