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

// The opening tag of a highlighted term. Also the literal the nesting guard
// below looks for, so the two cannot drift apart.
const JARGON_TERM_OPEN = '<button type="button" class="jargon-term"';

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
          
          // Check if we're already inside a jargon button
          const lastTermStart = beforeMatch.lastIndexOf(JARGON_TERM_OPEN);
          const lastTermEnd = beforeMatch.lastIndexOf('</button>');
          
          if (lastTermStart > lastTermEnd) {
            return match; // We're inside a jargon term, don't replace
          }
          
          // Simple check for data-tooltip attributes
          // Look for data-tooltip=" that's not closed before our position
          const tooltipMatches = beforeMatch.match(/data-tooltip="[^"]*$/);
          if (tooltipMatches) {
            return match; // We're inside an unclosed tooltip attribute
          }
          
          // The term is a real button, so a keyboard user can reach it and open
          // its definition with Enter or Space. class stays right after `type`:
          // the guard above recognises an existing term by the literal prefix
          // JARGON_TERM_OPEN.
          return `${JARGON_TERM_OPEN} data-term="${escapedCanonicalTerm}" data-tooltip="${escapedDefinition}" aria-haspopup="dialog">${match}</button>`;
        });
      }
    });
    
    // Return sanitized HTML
    return DOMPurify.sanitize(processedContent);
  };