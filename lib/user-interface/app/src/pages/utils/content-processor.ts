import { marked } from 'marked';
import DOMPurify from 'dompurify';
import enGlossary from '../glossary/english.json';
import esGlossary from '../glossary/spanish.json';
import viGlossary from '../glossary/vietnamese.json';
import zhGlossary from '../glossary/chinese.json';

// Configure marked options
marked.setOptions({
  gfm: true,
  breaks: true
});

const jargonDictionaries = {
  en: enGlossary,
  es: esGlossary,
  vi: viGlossary,
  zh: zhGlossary
};

const escapeForAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export const processContentWithJargon = (content: string, languageCode: string): string => {
    if (!content) return '';
    
    // Convert markdown to HTML
    const htmlContent = marked.parse(content);
    const htmlString = typeof htmlContent === 'string' ? htmlContent : '';
    
    // Get the appropriate jargon dictionary for the language
    const jargonDict = jargonDictionaries[languageCode as keyof typeof jargonDictionaries];
    
    if (!jargonDict) {
      // If no jargon dictionary exists for this language, just return sanitized HTML
      return DOMPurify.sanitize(htmlString);
    }
    
    // Create a safe copy of the content to process
    let processedContent = htmlString;
    
    // Sort jargon terms by length (longest first) to avoid conflicts
    const sortedTerms = Object.keys(jargonDict).sort((a, b) => b.length - a.length);
    
    // Process each jargon term
    sortedTerms.forEach(term => {
      // Escape special regex characters in the term
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedTerm}\\b`, 'gi');
      
      // Check if this term exists in the content
      const matches = processedContent.match(regex);
      if (matches) {
        // Properly escape the definition for HTML attribute
        const escapedDefinition = escapeForAttribute(jargonDict[term]);
        // The match below is case-insensitive, so the wrapped text is however
        // the document happened to write the word. Carry the dictionary key
        // too: the drawer titles itself off this, and reading the visible text
        // instead is what gave a parent a lowercase heading.
        const escapedCanonicalTerm = escapeForAttribute(term);

        // Replace only if the term is not already inside a data-tooltip attribute or jargon span
        processedContent = processedContent.replace(regex, (match, offset, string) => {
          // Get the text before this match
          const beforeMatch = string.substring(0, offset);
          
          // Check if we're already inside a jargon span
          const lastSpanStart = beforeMatch.lastIndexOf('<span class="jargon-term"');
          const lastSpanEnd = beforeMatch.lastIndexOf('</span>');
          
          if (lastSpanStart > lastSpanEnd) {
            return match; // We're inside a jargon span, don't replace
          }
          
          // Simple check for data-tooltip attributes
          // Look for data-tooltip=" that's not closed before our position
          const tooltipMatches = beforeMatch.match(/data-tooltip="[^"]*$/);
          if (tooltipMatches) {
            return match; // We're inside an unclosed tooltip attribute
          }
          
          // class stays first: the guard above recognises an existing span by
          // the literal prefix `<span class="jargon-term"`.
          return `<span class="jargon-term" data-term="${escapedCanonicalTerm}" data-tooltip="${escapedDefinition}">${match}</span>`;
        });
      }
    });
    
    // Return sanitized HTML
    return DOMPurify.sanitize(processedContent);
  };