const puppeteer = require('puppeteer-core');
const chromium = require("@sparticuz/chromium");
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

// Configure marked for GFM (GitHub Flavored Markdown) with table support
marked.setOptions({
  gfm: true,
  breaks: true,
  tables: true
});

// Set graphics mode to false for Lambda
chromium.setGraphicsMode = false;

// Escape text that is interpolated into the HTML outside of the markdown
// pipeline (language codes, section titles, page references). These values come
// from the user-supplied request body and would otherwise allow HTML injection.
const escapeHtml = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Allowlist for sanitizing the HTML produced from user-supplied markdown. Only
// the tags/attributes the PDF template actually styles are permitted; scripts,
// network-triggering elements (img/iframe/object/...), event handlers and inline
// styles are stripped to prevent HTML/JS injection and the resulting SSRF.
const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'hr', 'span', 'div',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
    'blockquote', 'code', 'pre',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col'
  ],
  allowedAttributes: {
    a: ['href'],
    th: ['colspan', 'rowspan', 'align'],
    td: ['colspan', 'rowspan', 'align'],
    col: ['span']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  allowProtocolRelative: false,
  // Drop disallowed tags but keep their (text) contents.
  disallowedTagsMode: 'discard',
  // No inline styles at all (blocks CSS url()/expression based requests).
  allowedStyles: {}
};

// Outbound requests permitted while Puppeteer renders the user-controlled
// document. The template only needs the inline data: document and the Google
// Fonts CDN; every other request is aborted to prevent SSRF.
const ALLOWED_REQUEST_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const isAllowedFontRequest = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && ALLOWED_REQUEST_HOSTS.has(hostname);
  } catch (err) {
    return false;
  }
};

// Convert user-supplied markdown to sanitized HTML. marked does not sanitize
// HTML, so its output can contain arbitrary user-supplied markup; sanitizing
// before the result is embedded in the Puppeteer-rendered page strips scripts,
// network-triggering elements, event handlers and inline styles (prevents
// HTML/JS injection -> SSRF).
const processContent = (content) => {
  if (!content) return '';

  let html;
  try {
    // Use marked to convert markdown to HTML (handles tables, lists, headers, etc.)
    const htmlContent = marked.parse(content);
    html = typeof htmlContent === 'string' ? htmlContent : '';
  } catch (error) {
    console.error('Error processing content with marked:', error);
    // Fallback: render the raw content as escaped plain text.
    html = `<p>${escapeHtml(content)}</p>`;
  }

  return sanitizeHtml(html, SANITIZE_OPTIONS);
};

exports.handler = async (event, context) => {
  let browser = null;
  try {
    console.log('PDF Generation Lambda started');
    
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }
    
    const { document: iepDocument, preferredLanguage, fileName } = body;
    
    if (!iepDocument) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'IEP document is required' })
      };
    }

    // Helper function to get language display name
    const getLanguageDisplayName = (language) => {
      const languageNames = {
        'en': 'English',
        'es': 'Spanish (Español)',
        'vi': 'Vietnamese (Tiếng Việt)',
        'zh': 'Chinese (中文)',
      };
      return languageNames[language] || language.toUpperCase();
    };

    // Generate HTML content for the PDF
    const generateHTMLContent = () => {
      let htmlContent = '';
      
      // Document header
      htmlContent += `
        <div class="document-header">
          <h1>IEP Document Summary and Translations</h1>
          <p class="subtitle">Generated on ${new Date().toLocaleDateString()}</p>
        </div>
      `;

      // Collect available languages
      const availableLanguages = new Set();
      
      // Check for summaries
      Object.keys(iepDocument.summaries || {}).forEach(lang => {
        const summary = iepDocument.summaries[lang];
        if (summary && summary.trim()) {
          availableLanguages.add(lang);
        }
      });
      
      // Check for sections
      Object.keys(iepDocument.sections || {}).forEach(lang => {
        const sections = iepDocument.sections[lang];
        if (sections && sections.length > 0) {
          availableLanguages.add(lang);
        }
      });

      // Order languages: preferred language first (if not English), then English
      const orderedLanguages = [];
      
      if (preferredLanguage !== 'en' && availableLanguages.has(preferredLanguage)) {
        orderedLanguages.push(preferredLanguage);
      }
      
      if (availableLanguages.has('en') && orderedLanguages.length < 2) {
        orderedLanguages.push('en');
      }

      // Generate content for each language
      orderedLanguages.forEach((language) => {
        const isTranslation = language !== 'en';
        // `language` is derived from attacker-controllable object keys, so escape
        // it everywhere it is interpolated into the HTML.
        const safeLang = escapeHtml(language);
        const safeLanguageName = escapeHtml(getLanguageDisplayName(language));

        htmlContent += `
          <div class="language-section" lang="${safeLang}">
            <h2 class="language-header" lang="${safeLang}">
              ${isTranslation ? 'Translation - ' : ''}${safeLanguageName}
            </h2>
        `;

        // Add summary if available
        const summary = iepDocument.summaries && iepDocument.summaries[language];
        if (summary && summary.trim()) {
          htmlContent += `
            <div class="section-container">
              <h3>IEP Summary</h3>
              <div class="section-content" lang="${safeLang}">${processContent(summary)}</div>
            </div>
          `;
        }

        // Get sections for this language
        const languageSections = iepDocument.sections && iepDocument.sections[language];

        if (!languageSections || languageSections.length === 0) {
          if (!summary || !summary.trim()) {
            htmlContent += `
              <p class="empty-content">
                No content available in ${safeLanguageName}
              </p>
            `;
          }
        } else {
          // Add sections header
          htmlContent += `<h3>Key Insights</h3>`;

          // Process each section
          languageSections.forEach((section) => {
            if (!section.content || !section.content.trim()) return;

            const safeSectionTitle = escapeHtml(section.displayName || section.name || 'Section');
            const safePageReference = Array.isArray(section.pageNumbers) && section.pageNumbers.length > 0
              ? `<p class="page-reference">Reference: Pages ${escapeHtml(section.pageNumbers.join(', '))} of original IEP document</p>`
              : '';

            htmlContent += `
              <div class="section-container">
                <h4>${safeSectionTitle}</h4>
                <div class="section-content" lang="${safeLang}">${processContent(section.content)}</div>
                ${safePageReference}
              </div>
            `;
          });
        }

        htmlContent += `</div>`;
      });

      return htmlContent;
    };

    // Complete HTML document with CSS
    const htmlDocument = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>IEP Document Summary</title>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&family=Noto+Sans:wght@400;700&display=swap" rel="stylesheet">
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          
          body {
            font-family: "Noto Sans", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background: white;
            padding: 25px;
            font-size: 11px;
          }
          
          .document-header {
            text-align: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: 3px solid #000;
          }
          
          .document-header h1 {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
            text-align: center;
          }
          
          .subtitle {
            font-size: 12px;
            color: #666;
            text-align: center;
          }
          
          .language-section {
            margin-bottom: 25px;
            padding-bottom: 20px;
            page-break-inside: avoid;
            border-bottom: 2px solid #e0e0e0;
          }
          
          .language-section:last-child {
            border-bottom: none;
          }
          
          .language-section:not(:first-child) {
            page-break-before: always;
          }
          
          .language-header {
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 20px;
            margin-top: 15px;
            padding: 12px 0;
            border-bottom: 2px solid #333;
            text-transform: uppercase;
            letter-spacing: 1px;
            page-break-after: avoid;
          }
          
          .section-container {
            margin-bottom: 20px;
            padding-bottom: 15px;
            page-break-inside: avoid;
          }
          
          .section-container h3 {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 12px;
            margin-top: 20px;
            padding-bottom: 5px;
            border-bottom: 1px solid #ccc;
            page-break-after: avoid;
          }
          
          .section-container h4 {
            font-size: 12px;
            font-weight: bold;
            margin-bottom: 10px;
            margin-top: 15px;
            color: #555;
            page-break-after: avoid;
          }
          
          .section-content {
            font-size: 11px;
            line-height: 1.7;
            text-align: justify;
            margin-bottom: 12px;
            text-indent: 0;
          }
          
          .section-content p {
            margin-bottom: 10px;
            text-align: justify;
          }
          
          .page-reference {
            font-size: 9px;
            color: #888;
            font-style: italic;
            margin-top: 8px;
            margin-bottom: 5px;
            text-align: left;
          }
          
          .empty-content {
            font-size: 11px;
            font-style: italic;
            color: #666;
            text-align: center;
            margin: 20px 0;
          }
          
          ul {
            margin: 15px 0 15px 25px;
            padding-left: 10px;
          }
          
          li {
            margin-bottom: 8px;
            line-height: 1.6;
            text-align: justify;
          }
          
          h1, h2, h3, h4 {
            page-break-after: avoid;
          }
          
          /* Table styles */
          table {
            width: 100%;
            border-collapse: collapse;
            margin: 15px 0;
            font-size: 10px;
            page-break-inside: avoid;
          }
          
          th, td {
            border: 1px solid #ddd;
            padding: 8px 10px;
            text-align: left;
            vertical-align: top;
            line-height: 1.4;
          }
          
          th {
            background-color: #f5f5f5;
            font-weight: bold;
            color: #333;
            page-break-after: avoid;
          }
          
          tr {
            page-break-inside: avoid;
          }
          
          tbody tr:nth-child(even) {
            background-color: #fafafa;
          }
          
          tbody tr:hover {
            background-color: #f0f0f0;
          }
          
          /* Ensure tables don't overflow */
          table {
            table-layout: fixed;
            word-wrap: break-word;
          }
          
          strong {
            font-weight: bold;
          }
          
          em {
            font-style: italic;
          }
          
          br {
            line-height: 1.8;
          }
          
          /* Specific font rules for CJK characters */
          *:lang(zh), 
          *:lang(zh-CN),
          *:lang(zh-TW) {
            font-family: "Noto Sans SC", "Noto Sans", sans-serif !important;
          }

          *:lang(vi) {
            font-family: "Noto Sans", "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif !important;
          }

          /* Ensure Chinese characters are properly rendered */
          .chinese {
            font-family: "Noto Sans SC", "Noto Sans", sans-serif !important;
          }

          @page {
            size: A4;
            margin: 25mm 20mm;
          }
          
          @media print {
            body {
              padding: 15px;
            }
            
            .language-section {
              margin-bottom: 30px;
            }
            
            .section-container {
              margin-bottom: 25px;
            }
          }
        </style>
      </head>
      <body>
        ${generateHTMLContent()}
      </body>
      </html>
    `;

    console.log("Launching browser...");
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || await chromium.executablePath();
    console.log("Executable path:", executablePath);
    
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--single-process',
        '--font-render-hinting=none',
        '--disable-font-subpixel-positioning',
        '--force-device-scale-factor=1',
        '--disable-features=VizDisplayCompositor',
        '--run-all-compositor-stages-before-draw',
        '--disable-backgrounding-occluded-windows'
      ],
      defaultViewport: chromium.defaultViewport,
      headless: chromium.headless || 'new',
      executablePath: executablePath,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Defense-in-depth against SSRF: the page is rendered from fully
    // user-controlled content, so block every outbound network request except
    // the inline data: document itself and the Google Fonts CDN the template
    // relies on. Anything else (internal metadata endpoints, arbitrary hosts,
    // file://, etc.) is aborted.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      const allowed =
        url.startsWith('data:') ||
        url.startsWith('about:') ||
        isAllowedFontRequest(url);
      try {
        if (allowed) {
          request.continue();
        } else {
          console.warn('Blocked outbound request during PDF render:', url.slice(0, 200));
          request.abort();
        }
      } catch (interceptError) {
        // The request may already have been handled (e.g. on a redirect); ignore.
      }
    });

    // Use navigation to a data URL
    await page.goto(`data:text/html,${encodeURIComponent(htmlDocument)}`, {
      waitUntil: 'networkidle0'
    });

    // Wait for fonts to load
    await page.evaluateHandle('document.fonts.ready');
    await page.waitForTimeout(2000); // Additional wait for font rendering

    const pdf = await page.pdf({
      format: 'A4',
      margin: {
        top: '20mm',
        left: '20mm',
        right: '20mm',
        bottom: '20mm'
      },
      printBackground: true
    });

    // Sanitize the filename for the Content-Disposition header
    const sanitizedFilename = encodeURIComponent(fileName || 'IEP_Summary_and_Translations').replace(/%20/g, "_");

    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=${sanitizedFilename}.pdf`,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: pdf.toString('base64')
    };
  } catch (error) {
    console.error('Error generating PDF:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({ 
        error: 'Failed to generate PDF', 
        details: error.message 
      })
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
  }
};