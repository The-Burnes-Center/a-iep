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

const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['en', 'es', 'zh', 'vi', 'ar'];

// Module-level cache of loaded translation dictionaries. Combined with the
// idle-time prefetch below, this makes language switches instant: by the time
// a user reaches the language picker, every dictionary is already in memory.
const translationCache: Partial<Record<SupportedLanguage, Record<string, string>>> = {};

const fetchTranslations = async (lang: SupportedLanguage): Promise<Record<string, string>> => {
  const cached = translationCache[lang];
  if (cached) return cached;
  // Dynamic import keeps each language out of the main bundle (~15KB gz each)
  const translationModule = await import(`../translations/${lang}.json`);
  translationCache[lang] = translationModule.default;
  return translationModule.default;
};

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
  // True once the FIRST translation file has loaded. Children are not
  // rendered before that, otherwise t() returns raw keys (e.g. "auth.title")
  // while the language chunk is still downloading. Stays true on later
  // language switches so the app isn't unmounted (old strings show briefly
  // instead).
  const [initialLoadDone, setInitialLoadDone] = useState<boolean>(false);

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
      setTranslations(await fetchTranslations(lang));
      setTranslationsLoaded(true); // Set to true when translations are loaded
      setInitialLoadDone(true);
    } catch (error) {
      // console.error(`Failed to load translations for ${lang}:`, error);
      // Fallback to English if translation file is missing
      if (lang !== 'en') {
        try {
          setTranslations(await fetchTranslations('en'));
        } catch (fallbackError) {
          // console.error('Failed to load fallback translations:', fallbackError);
        }
      }
      setTranslationsLoaded(true); // Still set to true even if there was an error
      setInitialLoadDone(true);
    }
  };

  // Load translations on initial render
  useEffect(() => {
    applyDirection(language); // Keep document dir/lang and Bootstrap LTR/RTL build in sync
    loadTranslations(language);
  }, [language]); // Added language as dependency to reload when it changes

  // Once the active language is loaded, prefetch the remaining dictionaries
  // in the background during idle time so switching languages never waits on
  // the network. Failures are ignored — the switch path loads on demand.
  useEffect(() => {
    if (!initialLoadDone) return;
    const prefetchRemaining = () => {
      SUPPORTED_LANGUAGES
        .filter((lang) => !translationCache[lang])
        .forEach((lang) => { fetchTranslations(lang).catch(() => {}); });
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetchRemaining, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(prefetchRemaining, 2000);
    return () => clearTimeout(id);
  }, [initialLoadDone]);

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
    initialLoadDone ? children : null
  );
};

// Custom hook for using the language context
export const useLanguage = () => useContext(LanguageContext);