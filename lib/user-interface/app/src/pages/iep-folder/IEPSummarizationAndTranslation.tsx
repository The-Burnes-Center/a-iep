import React, { useState, useEffect, useMemo, useContext } from 'react';
import { Container, Row, Col, Card, Spinner, Alert, Button, Accordion, Tabs, Tab, Offcanvas, Dropdown} from 'react-bootstrap';
import LinearProgress from '@mui/material/LinearProgress';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useNavigate } from 'react-router-dom';
import { faLanguage, faDownload, faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import './IEPSummarizationAndTranslation.css';
import { IEPDocument, IEPSection, UserProfile } from '../../common/types';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import { useFeatures } from '../../common/hooks/use-features';
import { getDirForLanguage } from '../../common/direction';
import { useDocumentFetch, processContentWithJargon } from '../utils';
import { FetchedIEPDocument } from '../utils/useDocumentFetch';
import {
  buildLanguageMenuOptions,
  idleTranslationRequest,
  hasRequestedTranslationFailed,
  isRequestedTranslationReady,
  isTranslationInFlight,
  mapTranslationResponse,
  resumeTranslationRequest,
  shouldOfferTranslation,
  shouldSuppressProcessingTakeover,
} from '../utils/translation-flow.mjs';
import type { TranslationRequestState } from '../utils/translation-flow.mjs';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import TTSPlayButton from '../../components/TTSPlayButton';
import { SlideData } from '../../components/ParentRightsCarousel';
import ProcessingModal from '../../components/ProcessingModal';
import AIEPFooter from '../../components/AIEPFooter';
import { ApiClient } from '../../common/api-client/api-client';
import {
  IEPDocumentClient,
  TranslationRequestError,
} from '../../common/api-client/iep-document-client';
import { AppContext } from '../../common/app-context';
import { TextHelper } from '../../common/helpers/text-helper';

// How long an on-demand translation may run before the page calls it failed and
// offers the button again. Whole-document translation is a multi-minute job, so
// this is a backstop against a request that vanished, not a real deadline.
const TRANSLATION_TIMEOUT_MS = 10 * 60 * 1000;

const IEPSummarizationAndTranslation: React.FC = () => {
  const { t, language, setLanguage, translationsLoaded, enabledLanguages } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  // Audio playback is dark on prod (see common/features.ts): the buttons are
  // the only caller of the audio route, so hiding them is what makes it dark.
  const ttsEnabled = isFeatureEnabled('tts');
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  // The documents client is not exposed on ApiClient; useDocumentFetch builds
  // its own the same way.
  const iepDocumentClient = useMemo(() => new IEPDocumentClient(appContext), [appContext]);

  // An on-demand translation the parent asked for: which language, how far
  // along, and which message to show. All transitions come from
  // ../utils/translation-flow so they can be unit tested.
  const [translationRequest, setTranslationRequest] =
    useState<TranslationRequestState>(idleTranslationRequest);
  const isTranslatingOnDemand = isTranslationInFlight(translationRequest.phase);

  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [showJargonDrawer, setShowJargonDrawer] = useState(false);
  const [selectedJargon, setSelectedJargon] = useState<{term: string, definition: string} | null>(null);
  const [isGeneratingPDF, setIsGeneratingPDF] = useState<boolean>(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  
  // State to track expanded/collapsed status for each language's summary
  const [isSummaryExpanded, setIsSummaryExpanded] = useState<Record<string, boolean>>({
    en: false,
    es: false,
    vi: false,
    zh: false,
    ar: false
  });
  
  // Profile-related state
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState<boolean>(true);
  const [originalProfile, setOriginalProfile] = useState<UserProfile | null>(null);
  const [, setSaving] = useState<boolean>(false);
  
  // Tutorial flow state management
  const [tutorialPhase, setTutorialPhase] = useState< 'parent-rights' | 'completed'>('parent-rights');

  const [document, setDocument] = useState<IEPDocument>({
    documentId: undefined,
    documentUrl: undefined,
    status: undefined,
    message: '',
    abbreviations: {
      en: []
    },
    summaries: {
      en: '',
      es: '',
      vi: '',
      zh: '',
      ar: ''
    },
    document_index: {
      en: '',
      es: '',
      vi: '',
      zh: '',
      ar: ''
    },
    sections: {
      en: [],
      es: [],
      vi: [],
      zh: [],
      ar: []
    }
  });
  
  const [activeTab, setActiveTab] = useState<string>('en');
  // Add state for dropdown language selection (separate from global language preference)
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  // Track if user has manually selected a language (to prevent auto-reset)
  const [hasUserSelectedLanguage] = useState<boolean>(false);
  const navigate = useNavigate();
  
  // Get preferred language from profile API, fallback to context language, then to 'en'
  const preferredLanguage = profile?.secondaryLanguage || language || 'en';

  // Load profile data on component mount
  useEffect(() => {
    const loadProfile = async () => {
      try {
        setProfileLoading(true);
        const profileData = await apiClient.profile.getProfile();
        setProfile(profileData);
        setOriginalProfile(profileData);
        
        // Sync the language context if profile has a different secondary language
        if (profileData?.secondaryLanguage && profileData.secondaryLanguage !== language) {
          setLanguage(profileData.secondaryLanguage as SupportedLanguage);
        }
      } catch (err) {
        // console.error('Error loading profile:', err);
        // Profile loading failure is not critical, continue with context language
      } finally {
        setProfileLoading(false);
      }
    };

    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only profile load by design; apiClient/setLanguage are recreated every render
  }, []);

  // Initialize selectedLanguage and activeTab after document loads
  useEffect(() => {
    // Don't initialize until initial loading is complete
    if (initialLoading) return;
    
    // Skip if user has manually selected a language via the dropdown
    if (hasUserSelectedLanguage) return;
    
    if (preferredLanguage !== 'en' && hasContent(preferredLanguage)) {
      setSelectedLanguage(preferredLanguage);
      setActiveTab(preferredLanguage);
    } else {
      setSelectedLanguage('en');
      setActiveTab('en');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasContent is recreated every render; the document fields it reads are already dependencies
  }, [preferredLanguage, initialLoading, document.summaries, document.sections, hasUserSelectedLanguage]);

  // Every language enabled in this environment. The picker offers all of them,
  // translated or not — see languageMenuOptions below.
  const allLanguageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  const handlePreferredLanguageChange = async (languageCode: string) => {
    if (!profile || languageCode === profile.secondaryLanguage) return;

    const previousLanguage = language;
    const updatedProfile = {...profile, secondaryLanguage: languageCode};
    setProfile(updatedProfile);
    // Switch the UI immediately; the profile save runs in the background
    setLanguage(languageCode as SupportedLanguage);

    try {
      setSaving(true);
      // Send only the changed field: a partial update skips re-encrypting
      // untouched PII fields (phone/city/parentName) with KMS on the backend
      await apiClient.profile.updateProfile({ secondaryLanguage: languageCode });

      setOriginalProfile(updatedProfile);
    } catch (err) {
      // Revert on error
      setProfile(originalProfile);
      setLanguage(previousLanguage);
    } finally {
      setSaving(false);
    }
  };

  // Handle language change - updates tab content and app language
  const handleLanguageChange = (lang: SupportedLanguage) => {
    handlePreferredLanguageChange(lang);
  };


  // Parent Rights carousel data - internationalized using useLanguage hook.
  //
  // Three dividers split the deck into the sections a parent is walked
  // through: what the app is doing with their document, the rights they hold,
  // and what the finished summary will look like. Reaching the end does NOT
  // end the wait — the carousel wraps and keeps going until the document's
  // status says it is done.
  const parentRightsSlideData = useMemo(() => {
    if (!translationsLoaded) return [];

    return [
      {
        id: 'section-what-aiep-does',
        type: 'section',
        title: t('carousel.section.whatAiepDoes'),
        content: '',
        theme: 'green'
      },
      {
        id: 'privacy-slide-1',
        type: 'privacy',
        title: t('privacy.slide1.title'),
        content: t('privacy.slide1.content'),
        image: '/images/carousel/joyful.png'
      },
      {
        id: 'privacy-slide-2',
        type: 'privacy',
        title: t('privacy.slide2.title'),
        content: t('privacy.slide2.content'),
        image: '/images/carousel/joyful.png'
      },
      {
        id: 'section-your-rights',
        type: 'section',
        title: t('carousel.section.yourRights'),
        content: '',
        theme: 'pink'
      },
      {
        id: 'rights-slide-1',
        type: 'rights',
        title: t('rights.slide1.title'),
        content: t('rights.slide1.content'),
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'rights-slide-2',
        type: 'rights',
        title: t('rights.slide2.title'),
        content: t('rights.slide2.content'),
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'rights-slide-3',
        type: 'rights',
        title: t('rights.slide3.title'),
        content: t('rights.slide3.content'),
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'rights-slide-4',
        type: 'rights',
        title: t('rights.slide4.title'),
        content: t('rights.slide4.content'),
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'rights-slide-5',
        type: 'rights',
        title: t('rights.slide5.title'),
        content: t('rights.slide5.content'),
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'rights-slide-6',
        type: 'rights',
        title: t('rights.slide6.title'),
        content: t('rights.slide6.content'),
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'section-what-you-will-see-next',
        type: 'section',
        title: t('carousel.section.whatYouWillSeeNext'),
        content: '',
        theme: 'blue'
      },
      {
        id: 'tutorial-slide-1',
        type: 'tutorial',
        title: t('rights.slide7.title'),
        content: t('rights.slide7.content'),
        image: '/images/tutorial-01.jpg'
      },
      {
        id: 'tutorial-slide-2',
        type: 'tutorial',
        title: t('rights.slide8.title'),
        content: t('rights.slide8.content'),
        image: '/images/tutorial-02.jpg'
      },
      {
        id: 'tutorial-slide-3',
        type: 'tutorial',
        title: t('rights.slide9.title'),
        content: t('rights.slide9.content'),
        image: '/images/tutorial-03.jpg'
      },
      {
        id: 'tutorial-slide-4',
        type: 'tutorial',
        title: t('rights.slide10.title'),
        content: t('rights.slide10.content'),
        image: '/images/tutorial-04.jpg'
      }
    ] as SlideData[];
  }, [t, translationsLoaded]);


  // Handle jargon click
  const handleContentClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('jargon-term')) {
      e.preventDefault();
      const term = target.textContent || '';
      const definition = target.getAttribute('data-tooltip') || '';
      setSelectedJargon({ term, definition });
      setShowJargonDrawer(true);
    }
  };
  
  const sectionDisplayNames: Record<string, Record<string, string>> = {
    "Strengths":        { en: "Strengths",                       es: "Fortalezas",                    vi: "Điểm Mạnh",                        zh: "优势",       ar: "نقاط القوة" },
    "Eligibility":      { en: "Eligibility",                     es: "Elegibilidad",                  vi: "Điều kiện hội đủ",                  zh: "资格条件",   ar: "الأهلية" },
    "Present Levels":   { en: "Present Levels of Performance",   es: "Niveles Actuales de Desempeño", vi: "Mức Độ Hiệu Suất Hiện Tại",        zh: "当前表现水平", ar: "مستويات الأداء الحالية" },
    "Goals":            { en: "Goals",                           es: "Objetivos",                     vi: "Mục Tiêu",                          zh: "目标",       ar: "الأهداف" },
    "Services":         { en: "Services",                        es: "Servicios",                     vi: "Dịch Vụ",                           zh: "服务",       ar: "الخدمات" },
    "Accommodations":   { en: "Accommodations",                  es: "Adaptaciones",                  vi: "Điều Chỉnh Hỗ Trợ",                zh: "调整措施",   ar: "التسهيلات" },
    "Placement":        { en: "Placement",                       es: "Ubicación",                     vi: "Vị Trí Sắp Xếp",                   zh: "安置",       ar: "التنسيب التعليمي" },
    "Key People":       { en: "Key People",                      es: "Personas Clave",                vi: "Những Người Chủ Chốt",             zh: "关键人员",   ar: "الأشخاص الرئيسيون" },
    "Informed Consent": { en: "Consent",                         es: "Consentimiento Informado",      vi: "Chấp thuận sau khi được thông báo", zh: "知情同意",   ar: "الموافقة المستنيرة" },
  };

  const getDisplayName = (apiName: string, lang: string): string => {
    const section = sectionDisplayNames[apiName];
    if (!section) return apiName;
    return section[lang] || section['en'] || apiName;
  };

  // Helper function to convert abbreviations to markdown table
  const convertAbbreviationsToMarkdown = (abbreviations: Array<{ abbreviation: string; full_form: string }>) => {
    if (!abbreviations || abbreviations.length === 0) return '';
    
    let markdown = '| Abbreviation | Full Form |\n| --- | --- |\n';
    abbreviations.forEach(item => {
      markdown += `| ${item.abbreviation} | ${item.full_form} |\n`;
    });
    
    return markdown;
  };

  const sectionOrder = Object.keys(sectionDisplayNames);

  const sortSections = (sections: IEPSection[]) => {
    return [...sections].sort((a, b) => {
      const indexA = sectionOrder.indexOf(a.name);
      const indexB = sectionOrder.indexOf(b.name);

      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return 0;
    });
  };

  // Process document sections for a specific language
  const processLanguageSections = (doc: FetchedIEPDocument, lang: string) => {
    // Sections are normalizable as soon as the pipeline has produced them.
    //
    // PROCESSED is the end of the initial pipeline. PROCESSING_TRANSLATIONS is
    // written only by the on-demand single-language translation of a document
    // that is ALREADY processed: the English content is final and the backend
    // merely appends a new language key (translate_content merges per language
    // and never rewrites 'en'). Excluding it left displayName undefined, so
    // every Key Insights header rendered blank for the whole minutes-long wait
    // while the parent read the English summary underneath.
    if (!doc || (doc.status !== "PROCESSED" && doc.status !== "PROCESSING_TRANSLATIONS")) return;
    
    if (doc.sections && doc.sections[lang]) {
      try {
        const extractedSections = [];
        
        if (Array.isArray(doc.sections[lang])) {
          doc.sections[lang].forEach(section => {
            if (section.title && section.content) {
              extractedSections.push({
                name: section.title,
                displayName: getDisplayName(section.title, lang),
                content: section.content,
                pageNumbers: section.page_numbers || []
              });
            }
          });
        }
        
        const orderedSections = sortSections(extractedSections);

        const translatedAbbreviations = {
          "en": "Abbreviations",
          "es": "Abreviaturas",
          "vi": "Chữ viết tắt",
          "zh": "缩写",
          "ar": "الاختصارات"
        };
        
        if ( doc.abbreviations && doc.abbreviations[lang] && doc.abbreviations.en && doc.abbreviations.en.length > 0) {
          const abbreviationsMarkdown = convertAbbreviationsToMarkdown(doc.abbreviations[lang]);
          orderedSections.push({
            name: 'Abbreviations',
            displayName: translatedAbbreviations[lang],
            content: abbreviationsMarkdown,
            pageNumbers: []
          });
        }
        
        // console.log("orderedSections", orderedSections);
        
        setDocument(prev => ({
          ...prev, 
          sections: { 
            ...prev.sections,
            [lang]: orderedSections
          }
        }));
      } catch (e) {
        // console.error(`Error processing ${lang} sections:`, e);
        setDocument(prev => ({
          ...prev, 
          sections: { 
            ...prev.sections,
            [lang]: []
          }
        }));
      }
    } else {
      // console.log(`No ${lang} sections found`);
      setDocument(prev => ({
        ...prev, 
        sections: { 
          ...prev.sections,
          [lang]: []
        }
      }));
    }
  };

  // Process all document sections
  const processDocumentSections = (doc: FetchedIEPDocument) => {
    // Normalize every language the document carries, not just English plus
    // whatever preferredLanguage holds at this instant. The profile's language
    // arrives asynchronously (the page syncs it from secondaryLanguage on
    // mount), so keying off it raced the document fetch: on a fresh browser,
    // where no stored preference short-circuits the sync, this ran while the
    // value was still 'en' and the translated pane kept the raw API sections.
    // Those lack the canonical section name, so the pane's audio buttons could
    // never work. Normalizing every pane is an in-memory transform and removes
    // the ordering dependency entirely.
    const languages = Object.keys(doc?.sections ?? {});
    if (!languages.includes('en')) {
      // Preserved from the original: 'en' is normalized even when absent, which
      // is what clears stale English sections out of state.
      languages.unshift('en');
    }

    for (const lang of languages) {
      processLanguageSections(doc, lang);
    }
  };

    useDocumentFetch({
    translationsLoaded,
    document,
    initialLoading,
    setDocument,
    setError,
    setInitialLoading,
    processDocumentSections,
    // Refetch the moment a translation request starts, and keep the existing
    // poller alive until it finishes, even if the status read lags behind.
    forcePolling: isTranslatingOnDemand
  });


  // Safe check for content availability
  const hasContent = (lang: string) => {
    const hasSummary = Boolean(document.summaries && document.summaries[lang]);
    const hasDocumentIndex = Boolean(document.document_index && document.document_index[lang]);
    const hasSections = Boolean(
      document.sections && 
      document.sections[lang] && 
      document.sections[lang].length > 0
    );
    
    return hasSummary || hasSections || hasDocumentIndex;
  };

  // Every enabled language this document already carries. Drives the picker's
  // "not translated yet" markers and the decision to offer generating one.
  const translatedLanguages = allLanguageOptions
    .map(option => option.value)
    .filter(value => hasContent(value));

  // The picker lists every enabled language, not only the translated ones: a
  // parent has to be able to pick their language in order to be offered a
  // translation of it.
  const languageMenuOptions = buildLanguageMenuOptions(allLanguageOptions, translatedLanguages);

  const canOfferTranslation = shouldOfferTranslation({
    documentStatus: document.status,
    preferredLanguage,
    translatedLanguages
  });

  // Ask the backend for the missing translation. The response only tells us
  // whether generation started; the document poller is what brings the content
  // in, and the effect below is what moves the parent onto it.
  const handleGenerateTranslation = async () => {
    const iepId = document.documentId;
    if (!iepId || preferredLanguage === 'en') {
      // Unreachable from the UI (the banner only renders for a document with
      // English content and a non-English preference), but a button that does
      // nothing at all when clicked is undiagnosable — fail visibly instead.
      setTranslationRequest({
        phase: 'failed',
        language: preferredLanguage,
        messageKey: 'summary.translate.error.generic'
      });
      return;
    }

    setTranslationRequest({
      phase: 'requesting',
      language: preferredLanguage,
      messageKey: 'summary.translate.starting'
    });

    try {
      const result = await iepDocumentClient.requestTranslation(iepId, preferredLanguage);
      setTranslationRequest({
        ...mapTranslationResponse({ httpStatus: result.httpStatus }),
        language: preferredLanguage
      });
    } catch (err) {
      // Map the status code to one of our own messages: the endpoint's bodies
      // are generic on purpose and must never be shown to a parent.
      const httpStatus = err instanceof TranslationRequestError ? err.httpStatus : 0;
      setTranslationRequest({
        ...mapTranslationResponse({ httpStatus }),
        language: preferredLanguage
      });
    }
  };

  // Check if document is processing (includes both initial processing and translations)
  const isProcessing = document && (document.status === "PROCESSING" || document.status === "PROCESSING_TRANSLATIONS");

  // An on-demand translation puts the document back into
  // PROCESSING_TRANSLATIONS, which would otherwise hide the page behind the
  // full-screen ProcessingModal. The parent already has readable English
  // content here, so the progress stays inline in the banner instead.
  // Deliberately not passed the phase: suppression is decided by the document
  // alone, so that it survives an unmount. See the function's own comment.
  const suppressProcessingTakeover = shouldSuppressProcessingTakeover({
    documentStatus: document.status,
    hasEnglishContent: hasContent('en')
  });

  // Adopt the document's own view of a translation in flight, for a page that
  // has no request of its own.
  //
  // The bottom nav is a ROUTE change (MobileTopNavigation calls navigate), so
  // stepping over to Account and back unmounts this page and resets
  // translationRequest to idle. Without this the progress bar vanished
  // mid-translation and never came back, the button reappeared as if nothing
  // had been pressed, and neither the arrival nor a failure was reported —
  // every one of those reads the phase. Rebuilding it from the document is what
  // makes the wait survive a tab change, a reload, or a second device.
  //
  // Only from 'idle', deliberately. A request this page is already running
  // needs no help, and a 'failed' one must not be quietly resurrected into a
  // spinner: that would undo the backstop below and loop for as long as the
  // document sat at PROCESSING_TRANSLATIONS. A parent who was shown an error
  // gets the button, and pressing it is what starts a new wait.
  useEffect(() => {
    if (translationRequest.phase !== 'idle') return;
    // Wait for the profile. preferredLanguage falls back to the language
    // CONTEXT until it lands, so adopting early can pin the resumed request to
    // the wrong language, and the guard above then keeps that wrong answer for
    // the rest of the run.
    if (profileLoading) return;

    const resumed = resumeTranslationRequest({
      documentStatus: document.status,
      preferredLanguage,
      translatedLanguages
    });
    if (!resumed) return;

    setTranslationRequest(resumed);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- translatedLanguages is recreated every render; the document fields it reads are already dependencies
  }, [translationRequest.phase, profileLoading, document.status, preferredLanguage, document.summaries, document.sections]);

  // Once the translation the parent asked for lands, take them to it. The
  // switch waits for content in that language on a PROCESSED document: the
  // preferred-language tab is not mounted before then, and the effect further
  // down force-resets selectedLanguage to 'en' for a language with no content.
  useEffect(() => {
    if (!isRequestedTranslationReady({
      phase: translationRequest.phase,
      language: translationRequest.language,
      documentStatus: document.status,
      translatedLanguages
    })) return;

    const readyLanguage = translationRequest.language as string;
    setSelectedLanguage(readyLanguage);
    setActiveTab(readyLanguage);
    setTranslationRequest(idleTranslationRequest());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- translatedLanguages is recreated every render; the document fields it reads are already dependencies
  }, [translationRequest, document.status, document.summaries, document.sections]);

  // A translation that finished WITHOUT producing the language. The backend
  // leaves such a document PROCESSED on purpose, so the parent keeps the English
  // content they already had, and records the outcome in current_step instead.
  // Reading it here is what turns a failure into an immediate, retryable message
  // rather than a progress bar that runs until the timeout below.
  useEffect(() => {
    if (!hasRequestedTranslationFailed({
      phase: translationRequest.phase,
      language: translationRequest.language,
      documentStatus: document.status,
      currentStep: document.current_step,
      translatedLanguages
    })) return;

    setTranslationRequest(prev => (
      prev.phase === 'running'
        ? { ...prev, phase: 'failed', messageKey: 'summary.translate.error.failed' }
        : prev
    ));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- translatedLanguages is recreated every render; the document fields it reads are already dependencies
  }, [translationRequest, document.status, document.current_step, document.summaries, document.sections]);

  // Never leave a parent on a progress bar that cannot end. Translating a whole
  // IEP takes minutes, so the cap is generous, but a request that silently went
  // nowhere has to become a retryable error rather than an endless spinner.
  useEffect(() => {
    if (translationRequest.phase !== 'running') return;

    const timer = setTimeout(() => {
      setTranslationRequest(prev => (
        prev.phase === 'running'
          ? { ...prev, phase: 'failed', messageKey: 'summary.translate.error.generic' }
          : prev
      ));
    }, TRANSLATION_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [translationRequest.phase]);

  // The wait ends when the DOCUMENT says it does, never when the parent
  // reaches the end of the carousel. Swiping through the slides used to flip
  // this to 'completed', which replaced the carousel with a bare spinner and
  // gave the parent no way back to it; now the deck loops and only the status
  // moves this on. Once it does, `isProcessing` goes false, this screen
  // unmounts, and the summary below renders in its place — the summary lives
  // on this same route, so there is nothing to navigate to.
  useEffect(() => {
    setTutorialPhase(isProcessing ? 'parent-rights' : 'completed');
  }, [isProcessing]);



  // Set active tab based on selected language and content availability
  useEffect(() => {
    // Don't set active tab during any processing phase
    if (isProcessing) {
      return;
    }
    
    // Set active tab to selected language if content exists, otherwise fall back to English
    if (hasContent(selectedLanguage)) {
      setActiveTab(selectedLanguage);
    } else {
      setActiveTab('en');
      setSelectedLanguage('en');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasContent is recreated every render; the document fields it reads are already dependencies
  }, [selectedLanguage, document.summaries, document.sections, isProcessing]);


  // Handle PDF download
  const handleDownloadPDF = async () => {
    if (!apiClient.pdf.canGeneratePDF(document)) {
      setPdfError('No content available for PDF generation');
      return;
    }

    setIsGeneratingPDF(true);
    setPdfError(null);

    try {
      await apiClient.pdf.generatePDF({
        document,
        preferredLanguage,
        fileName: 'IEP_Summary_and_Translations'
      });
    } catch (error) {
      // console.error('PDF generation failed:', error);
      setPdfError(error instanceof Error ? error.message : 'Failed to generate PDF');
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  // Helper function to truncate content to the first paragraph
  const truncateContent = (content: string): { truncated: string; needsTruncation: boolean } => {
    if (!content) {
      return { truncated: content, needsTruncation: false };
    }
    
    // Split by double newline (paragraph separator)
    const paragraphs = content.split(/\n\n+/);
    
    // If there's only one paragraph (or no paragraph breaks), no truncation needed
    if (paragraphs.length <= 1) {
      return { truncated: content, needsTruncation: false };
    }
    
    // Return the first paragraph as truncated content with ".." appended to indicate continuation
    const firstParagraph = paragraphs[0].trim();
    return { truncated: firstParagraph + '..', needsTruncation: true };
  };

  // Toggle summary expansion for a specific language
  const toggleSummaryExpansion = (lang: string) => {
    setIsSummaryExpanded(prev => ({
      ...prev,
      [lang]: !prev[lang]
    }));
  };

  // Render tab content for a specific language
  const renderTabContent = (lang: string) => {
    const hasSummary = document.summaries && document.summaries[lang];
    const hasSections = (
      document.sections && 
      document.sections[lang] && 
      document.sections[lang].length > 0
    );
    
    const isEnglishTab = lang === 'en';

    // Content direction follows the CONTENT language, not the UI language
    // (e.g. Arabic UI viewing the English tab stays LTR, and vice versa)
    return (
      // data-testid: stable E2E hook per language pane (the tab nav is
      // CSS-hidden, so a spec cannot find these panes by their tab labels)
      <div dir={getDirForLanguage(lang)} lang={lang} data-testid={`summary-tab-panel-${lang}`}>
        {/* Summary Section */}
        {hasSummary ? (
          <>
          <div className="summary-updated-at">  
            {document.updatedAt && (
              <span>{t('summary.lastUpdate')} {TextHelper.formatUnixTimestamp(document.updatedAt, lang)}</span>
            )}
          </div>
            <h4 className="summary-header mt-4 d-flex align-items-center gap-2">
              {isEnglishTab ? 'IEP Summary' : t('summary.iepSummary')}
              {ttsEnabled && (
                <TTSPlayButton
                  iepId={document.documentId}
                  language={lang}
                  target="summary"
                />
              )}
            </h4>
            <Card className="summary-content mb-3">
              <Card.Body>
                {(() => {
                  const fullContent = document.summaries[lang];
                  const { truncated, needsTruncation } = truncateContent(fullContent);
                  const isExpanded = isSummaryExpanded[lang];
                  const contentToShow = needsTruncation && !isExpanded ? truncated : fullContent;
                  
                  return (
                    <div
                      className="markdown-content"
                      onClick={handleContentClick}
                      // Stable E2E hook: lets a spec compare the English and
                      // translated summaries without scraping the whole page
                      data-testid={`summary-text-${lang}`}
                    >
                      <span
                        dangerouslySetInnerHTML={{ 
                          __html: processContentWithJargon(contentToShow, lang)
                        }}
                      />
                      {needsTruncation && (
                        <>
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSummaryExpansion(lang);
                            }}
                            style={{
                              textDecoration: 'underline',
                              cursor: 'pointer',
                              color: '#1E1E1E',
                              fontWeight: '500'
                            }}
                          >
                            {isExpanded ? t('summary.showLess') : t('summary.readMore')}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })()}
              </Card.Body>
            </Card>
          </>
        ) : (
          <Alert variant="info">
            <h5>
              {isEnglishTab 
                ? t('summary.noSummary.title')
                : t('summary.noTranslatedSummary.title')}
            </h5>
            <p>
              {isEnglishTab
                ? t('summary.noSummary.message')
                : t('summary.noTranslatedSummary.message')}
            </p>
            <Button 
                  variant="primary" 
                  size="sm"
                  onClick={() => navigate('/iep-documents')}
                >
                  {t('summary.reuploadButton')}
            </Button>
            {/* No second "re-upload to get a translation" prompt here: a missing
                translation is now handled by the generate-translation banner at
                the top of the page, not by throwing the document away. */}
          </Alert>
        )}

        {/* Sections Accordion */}
        {hasSections ? (
          <>
            <h4 className="key-insights-header mt-4 mb-3">
              {isEnglishTab ? 'Key Insights' : t('summary.keyInsights')}
            </h4>
            <Accordion className="mb-3 summary-accordion">
              {document.sections[lang].map((section, index) => (
                // data-testid: stable E2E hook for "the Key Insights
                // sections rendered" (the headings are localized content)
                <Accordion.Item key={index} eventKey={index.toString()} data-testid="summary-section">
                  <Accordion.Header>
                    {section.displayName}
                  </Accordion.Header>
                  <Accordion.Body>
                    {/* No audio at all where TTS is dark (prod), and none for
                        the client-fabricated Abbreviations table.
                        Also wait for section.name: this accordion renders
                        straight from document.sections[lang], which holds the
                        raw API shape (title/content) until the effect above
                        normalizes it into {name, displayName, ...}. Clicking in
                        that window sent target=section with no sectionName, which
                        the backend rejects with a 400 and which left the button
                        stuck showing an error a parent had to notice and retry. */}
                    {ttsEnabled && section.name && section.name !== 'Abbreviations' && (
                      <TTSPlayButton
                        iepId={document.documentId}
                        language={lang}
                        target="section"
                        sectionName={section.name}
                        className="mb-2"
                      />
                    )}
                    {section.pageNumbers && section.pageNumbers.length > 0 && (
                      <p className="text-muted mb-2 page-numbers-text">
                        <small>
                          <span className="page-numbers-label">
                            {isEnglishTab ? 'Found in ' : t('sections.foundIn') + ' '}
                          </span>
                          <span className="page-numbers-value">
                            {isEnglishTab ? 'pages ' : t('sections.pages') + ' '}
                            {Array.isArray(section.pageNumbers) 
                              ? section.pageNumbers.join(', ') 
                              : section.pageNumbers}
                          </span>
                        </small>
                      </p>
                    )}
                    <div 
                      className="markdown-content"
                      onClick={handleContentClick}
                      dangerouslySetInnerHTML={{ 
                        __html: processContentWithJargon(
                          section.content || t('summary.noContent'), 
                          lang
                        )
                      }}
                    />
                  </Accordion.Body>
                </Accordion.Item>
              ))}
            </Accordion>
          </>
        ) : (
          <Alert variant="info">
            <h5>
              {isEnglishTab
                ? t('summary.noSections.title')
                : t('summary.noTranslatedSections.title')}
            </h5>
            <p>
              {isEnglishTab
                ? t('summary.noSections.message')
                : t('summary.noTranslatedSections.message')}
            </p>
            <Button 
                  variant="primary" 
                  size="sm"
                  onClick={() => navigate('/iep-documents')}
                >
                  {t('summary.reuploadButton')}
            </Button>
            {/* Same as above: missing translations are offered for generation in
                the banner at the top, not fixed by re-uploading. */}
          </Alert>
        )}
      </div>
    );
  };

  // Get tab title based on language code
  const getTabTitle = (languageCode: string) => {
    switch(languageCode) {
      case 'en': return t('summary.english');
      case 'es': return 'Español';
      case 'vi': return 'Tiếng Việt';
      case 'zh': return '中文';
      case 'ar': return 'العربية';
      default: return languageCode.toUpperCase();
    }
  };

  // Handle initial loading and no document states first
  if (!translationsLoaded || profileLoading) {
    return (
      <Container className="summary-container mt-4 mb-5">
        <div className="text-center my-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
          <p className="mt-3">
            {!translationsLoaded && profileLoading ? 'Loading translations and profile...' :
             !translationsLoaded ? 'Loading translations...' : 
             'Loading profile...'}
          </p>
        </div>
      </Container>
    );
  }

  if (initialLoading) {
    return (
      <>
        <MobileTopNavigation />
        <Container className="summary-container mt-3 mb-3">
          <Row className="mt-2">
            <Col>
              <div className="text-center my-5">
                <Spinner animation="border" role="status">
                  <span className="visually-hidden">{t('summary.loading')}</span>
                </Spinner>
                <p className="mt-3">{t('summary.loading')}</p>
              </div>
            </Col>
          </Row>
        </Container>
      </>
    );
  }


  if (!document) {
    return (
      <>
        <MobileTopNavigation />
        <Container className="summary-container mt-3 mb-3">
          <Row className="mt-2">
            <Col>
              <Alert variant="info">
                {t('summary.noDocuments')}
              </Alert>
            </Col>
          </Row>
        </Container>
      </>
    );
  }


  // An unfinished profile belongs back in onboarding, NOT at '/'. That route
  // is the public LandingPage, whose only way back into the app is an "Upload
  // An IEP" link to /login — so tapping "Summary" in the bottom nav ejected an
  // already-authenticated parent onto the marketing site staring at a sign-in
  // form. Nothing signs them out; it only looks that way. /preferred-language
  // is where the other onboarding redirects go, and it gates onward from there.
  if(profile.showOnboarding){
    navigate('/preferred-language');
    return null;
  }

  if(document && document.message === "No document found for this child") {
      navigate('/iep-documents');
  }

  // Processing Container - when document is being processed. A translation the
  // parent requested from the banner is deliberately excluded: it reports its
  // progress inline so the English content they are reading stays on screen.
  if (isProcessing && !suppressProcessingTakeover) {
    // console.log("tutorialPhase", tutorialPhase);
    return (
      <ProcessingModal
        error={error}
        tutorialPhase={tutorialPhase}
        t={t}
        parentRightsSlideData={parentRightsSlideData}
        headerPinkTitle={t('rights.header.title.pink')}
        headerGreenTitle={t('rights.header.title.green')}
        rightsIndicatorTemplate={t('carousel.rights.indicator')}
        sectionHint={t('carousel.section.hint')}
      />
    );
  }

  // Processed Container - when document is processed, failed, or in other states
  return (
    <>
      <MobileTopNavigation />
      <Container className="summary-container mt-3 mb-3">
        <div className="mt-2 text-start button-container d-flex justify-content-between align-items-center">
          <div className="d-flex gap-2 align-items-center">
            {apiClient.pdf.canGeneratePDF(document) && (
              <Button
                variant="primary"
                onClick={handleDownloadPDF}
                disabled={isGeneratingPDF || isProcessing}
                className="download-button"
                // Stable E2E hook: the label is localized
                data-testid="download-pdf-button"
              >
                {isGeneratingPDF ? (
                  <>
                    <Spinner animation="border" size="sm" className="me-2" />
                    {t('common.generatingPdf')}
                  </>
                ) : (
                  <>
                    <FontAwesomeIcon icon={faDownload} className="me-2" />
                    {t('common.download')}
                  </>
                )}
              </Button>
            )}
          </div>
          
          {/* Language Dropdown - every language enabled in this environment,
              with the ones this document has no translation for marked as such:
              picking one is how a parent gets offered a translation of it.
              Disabled while a translation is being generated, because changing
              the preference mid-flight would leave the running request pointing
              at a language the parent no longer wants. */}
          {document && (document.status === "PROCESSED" || suppressProcessingTakeover) && languageMenuOptions.length > 1 && (
            <Dropdown className='language-dropdown-toggle'>
              <Dropdown.Toggle
                variant="outline-primary"
                id="language-dropdown"
                size="sm"
                disabled={isTranslatingOnDemand}
              >
                {(languageMenuOptions.find(option => option.value === selectedLanguage)?.label || 'English').toUpperCase()}
              </Dropdown.Toggle>
              <Dropdown.Menu>
                {languageMenuOptions.map(option => (
                  <Dropdown.Item
                    key={option.value}
                    onClick={() => handleLanguageChange(option.value as SupportedLanguage)}
                    active={selectedLanguage === option.value}
                    className="d-flex justify-content-between align-items-center gap-3"
                    // Stable E2E hook: the items are labelled with each
                    // language's own endonym
                    data-testid={`summary-language-option-${option.value}`}
                  >
                    <span>{option.label.toUpperCase()}</span>
                    {!option.isTranslated && (
                      <small
                        className="text-muted"
                        // Stable E2E hook: "this language has no translation yet"
                        data-testid={`summary-language-untranslated-${option.value}`}
                      >
                        {t('summary.translate.notTranslatedYet')}
                      </small>
                    )}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown>
          )}
        </div>
        
        {pdfError && (
          <Alert variant="danger" className="mt-2" dismissible onClose={() => setPdfError(null)}>
            <strong>PDF Generation Failed:</strong> {pdfError}
          </Alert>
        )}
        
        <Row className="mt-2">
          <Col>
            {error && <Alert variant="danger">{error}</Alert>}
            
            <Card className="summary-card">
              <Card.Body className="summary-card-body pt-2 pb-0">
                <Row className="g-0">
                  <Col md={12} className="no-padding-inherit">
                    {document.status === "FAILED" ? (
                      <Alert variant="danger">
                        {/* data-testid: stable E2E hook so the pipeline
                            journey can fail fast instead of waiting out its
                            budget. It sits on the heading, not on <Alert>,
                            because Alert forwards unknown props to its Fade
                            transition rather than to the rendered div. */}
                        <h5 data-testid="summary-failed">{t('summary.failed.title')}</h5>
                        <p>{t('summary.failed.message')}</p>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => navigate('/iep-documents')}
                        >
                          {t('summary.reuploadButton')}
                        </Button>
                      </Alert>
                    ) :
                      <>
                        {/* The preferred language has no translation yet: offer
                            to generate one right here. This used to send the
                            parent back to re-upload the document, which threw
                            away a perfectly good record to get a translation the
                            backend can produce on demand.
                            The progress state stays INLINE on purpose — the
                            English summary below is readable, and the
                            full-screen ProcessingModal would hide it. */}
                        {canOfferTranslation && (
                          <Alert
                            variant="warning"
                            className="mb-3"
                          >
                            <div className="d-flex align-items-start">
                              <FontAwesomeIcon icon={faLanguage} className="me-2 mt-1" />
                              <div className="flex-grow-1">
                                {/* data-testid sits on the heading, not on <Alert>:
                                    Alert forwards unknown props to its Fade
                                    transition rather than to the rendered div. */}
                                <h6 className="mb-2" data-testid="translate-preferred-language">
                                  {t('summary.noPreferredLanguageContent.title')}
                                </h6>
                                {isTranslatingOnDemand ? (
                                  <div data-testid="translation-progress">
                                    <p className="mb-2">
                                      {t(translationRequest.messageKey ?? 'summary.processing.almostThere')}
                                    </p>
                                    <LinearProgress color="success" />
                                  </div>
                                ) : (
                                  <>
                                    <p className="mb-2">{t('summary.translate.message')}</p>
                                    {translationRequest.phase === 'failed' && translationRequest.messageKey && (
                                      <p className="mb-2 text-danger" data-testid="translation-error">
                                        {t(translationRequest.messageKey)}
                                      </p>
                                    )}
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      onClick={handleGenerateTranslation}
                                      // Stable E2E hook: the label is localized
                                      data-testid="translate-now-button"
                                    >
                                      {t('summary.translate.button')}
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </Alert>
                        )}

                        {/* Only show content when document is fully processed */}

                        <Tabs
                          activeKey={activeTab}
                          onSelect={(k) => k && setActiveTab(k)}
                          className="mb-2 mt-2 summary-tabs hidden-tab-nav"
                        >
                          {/* Always show English tab */}
                          <Tab 
                            eventKey="en" 
                            title={t('summary.english')}
                          >
                            {renderTabContent('en')}
                          </Tab>
                          
                          {/* Show preferred language tab if content exists */}
                          {preferredLanguage !== 'en' && hasContent(preferredLanguage) && (
                            <Tab 
                              eventKey={preferredLanguage} 
                              title={
                                <span>
                                  <FontAwesomeIcon icon={faLanguage} className="me-1" />
                                  {getTabTitle(preferredLanguage)}
                                </span>
                              }
                            >
                              {renderTabContent(preferredLanguage)}
                            </Tab>
                          )}
                        </Tabs>
                        
                        {!hasContent('en') && !hasContent(preferredLanguage) && (
                          <Alert variant="info">
                            <h5>{t('summary.noContentAvailable.title')}</h5>
                            <p>{t('summary.noContentAvailable.message')}</p>
                            <Button 
                  variant="primary" 
                  size="sm"
                  onClick={() => navigate('/iep-documents')}
                >
                  {t('summary.reuploadButton')}
                </Button>
                          </Alert>
                        )}
                      </>
                  }
                  </Col>
                </Row>
              </Card.Body>
            
              {document.status === "PROCESSED" && (
                <Card.Header
                  className="summary-card-header d-flex justify-content-center align-items-center"
                  onClick={() => navigate('/iep-documents')}
                  style={{ cursor: 'pointer' }}
                  // Stable E2E hook: the replace-document entry point, whose
                  // label is localized
                  data-testid="replace-document-link"
                >
                  <div>
                    <FontAwesomeIcon icon={faArrowsRotate} className="me-2" />
                    {t('upload.replaceDocument')}
                  </div>
                </Card.Header>
              )}
            </Card>
          </Col>
        </Row>
        
        {/* Jargon Drawer */}
        <Offcanvas 
          show={showJargonDrawer} 
          onHide={() => setShowJargonDrawer(false)}
          placement="end"
          className="jargon-drawer"
        >
          <Offcanvas.Header closeButton>
            <Offcanvas.Title>{t('glossary.header')}</Offcanvas.Title>
          </Offcanvas.Header>
          <Offcanvas.Body>
            <h3>{selectedJargon?.term}</h3>
            <p>{selectedJargon?.definition}</p>
          </Offcanvas.Body>
        </Offcanvas>
      </Container>
      <AIEPFooter />
    </>
  );
};

export default IEPSummarizationAndTranslation;