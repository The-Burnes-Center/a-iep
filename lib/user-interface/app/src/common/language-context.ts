import React, { createContext, useState, useContext, useEffect } from 'react';
import { StorageHelper } from './helpers/storage-helper';
import { applyDirection } from './direction';

// Define supported languages
export type SupportedLanguage = 'en' | 'es' | 'zh' | 'vi' | 'ar';

// Define the context type
interface LanguageContextType {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  t: (key: string) => string;
  translationsLoaded: boolean; // Added translationsLoaded flag
}

// Create the context with default values
export const LanguageContext = createContext<LanguageContextType>({
  language: 'en',
  setLanguage: () => {},
  t: (key: string) => key,
  translationsLoaded: false, // Default is false
});

// Language context storage key
const LANGUAGE_STORAGE_KEY = 'aiep-language-preference';

// Create the provider component
export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  // Initialize with stored preference or default to English
  const [language, setLanguageState] = useState<SupportedLanguage>(() => {
    const stored = StorageHelper.getItem(LANGUAGE_STORAGE_KEY) as SupportedLanguage;
    return stored || 'en';
  });
  
  // Initialize with empty translations
  const [translations, setTranslations] = useState<Record<string, string>>({});
  // Add translationsLoaded state
  const [translationsLoaded, setTranslationsLoaded] = useState<boolean>(false);

  // Update language and store preference
  const setLanguage = (lang: SupportedLanguage) => {
    setLanguageState(lang);
    StorageHelper.setItem(LANGUAGE_STORAGE_KEY, lang);
    setTranslationsLoaded(false); // Reset loading state when changing language
    loadTranslations(lang);
  };

  // Load translations for the current language
  const loadTranslations = async (lang: SupportedLanguage) => {
    try {
      // Dynamic import to load only the needed language file
      const translationModule = await import(`../translations/${lang}.json`);
      setTranslations(translationModule.default);
      setTranslationsLoaded(true); // Set to true when translations are loaded
    } catch (error) {
      // console.error(`Failed to load translations for ${lang}:`, error);
      // Fallback to English if translation file is missing
      if (lang !== 'en') {
        try {
          const fallbackModule = await import('../translations/en.json');
          setTranslations(fallbackModule.default);
        } catch (fallbackError) {
          // console.error('Failed to load fallback translations:', fallbackError);
        }
      }
      setTranslationsLoaded(true); // Still set to true even if there was an error
    }
  };

  // Load translations on initial render
  useEffect(() => {
    applyDirection(language); // Keep document dir/lang and Bootstrap LTR/RTL build in sync
    loadTranslations(language);
  }, [language]); // Added language as dependency to reload when it changes

  // Translation function
  const t = (key: string): string => {
    return translations[key] || key;
  };

  // Include translationsLoaded in the context value
  const contextValue = { 
    language, 
    setLanguage, 
    t,
    translationsLoaded
  };
  
  return React.createElement(
    LanguageContext.Provider, 
    { value: contextValue }, 
    children
  );
};

// Custom hook for using the language context
export const useLanguage = () => useContext(LanguageContext);