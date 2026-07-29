import { Utils } from "../utils";
import { AppConfig } from "../types";
import { IEPDocument } from "../types";

export interface PDFGenerationOptions {
  document: IEPDocument;
  preferredLanguage: string;
  fileName?: string;
}

export class PDFClient {
  private readonly API;
  
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  /**
   * Generate and download a PDF from an IEP document
   */
  async generatePDF(options: PDFGenerationOptions): Promise<void> {
    const auth = await Utils.authenticate();

    const response = await fetch(this.API + '/generate-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate PDF');
    }

    // Get the filename from the response headers or use default
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = options.fileName || 'IEP_Summary_and_Translations';

    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename=([^;]+)/);
      if (filenameMatch) {
        filename = decodeURIComponent(filenameMatch[1].replace(/"/g, ''));
      }
    }

    // Ensure .pdf extension
    if (!filename.toLowerCase().endsWith('.pdf')) {
      filename += '.pdf';
    }

    // Convert response to blob and download
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    // Create download link and trigger download
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up the object URL
    URL.revokeObjectURL(url);
  }

  /**
   * Check if a document has sufficient content for PDF generation
   */
  canGeneratePDF(document: IEPDocument | null): boolean {
    if (!document || !document.sections) return false;
    
    // Check if we have summaries
    const hasSummaries = document.summaries && 
      Object.values(document.summaries).some(summary => 
        summary && typeof summary === 'string' && summary.trim().length > 0
      );

    // Check if we have sections content
    const hasSections = Object.values(document.sections).some(languageSections =>
      languageSections && languageSections.length > 0 && 
      languageSections.some(section => 
        section.content && section.content.trim().length > 0
      )
    );

    return hasSummaries || hasSections;
  }
}