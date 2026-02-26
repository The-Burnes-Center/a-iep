import React, { useState, useEffect, useMemo, useContext } from 'react';
import { Container, Row, Col, Card, Spinner, Alert, Button, Accordion, Tabs, Tab, Offcanvas, Dropdown} from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useNavigate } from 'react-router-dom';
import { faLanguage, faDownload, faArrowsRotate, faForward } from '@fortawesome/free-solid-svg-icons';
import './IEPSummarizationAndTranslation.css';
import { IEPDocument, IEPSection, Language, UserProfile } from '../../common/types';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { useDocumentFetch, processContentWithJargon } from '../utils';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import ParentRightsCarousel, { SlideData } from '../../components/ParentRightsCarousel';
import ProcessingModal from '../../components/ProcessingModal';
import AIEPFooter from '../../components/AIEPFooter';
import { ApiClient } from '../../common/api-client/api-client';
import { AppContext } from '../../common/app-context';
import { useNotifications } from '../../components/notif-manager';
import LinearProgress from '@mui/material/LinearProgress';
import { TextHelper } from '../../common/helpers/text-helper';

const IEPSummarizationAndTranslation: React.FC = () => {
  const { t, language, setLanguage, translationsLoaded } = useLanguage();
  const appContext = useContext(AppContext);
  const { addNotification } = useNotifications();
  const apiClient = new ApiClient(appContext);
  
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
    zh: false
  });
  
  // Profile-related state
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState<boolean>(true);
  const [originalProfile, setOriginalProfile] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  
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
      zh: ''
    },
    document_index: {
      en: '',
      es: '',
      vi: '',
      zh: ''
    },
    sections: {
      en: [],
      es: [],
      vi: [],
      zh: []
    }
  });
  
  const [activeTab, setActiveTab] = useState<string>('en');
  // Add state for dropdown language selection (separate from global language preference)
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  // Track if user has manually selected a language (to prevent auto-reset)
  const [hasUserSelectedLanguage, setHasUserSelectedLanguage] = useState<boolean>(false);
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
  }, [preferredLanguage, initialLoading, document.summaries, document.sections, hasUserSelectedLanguage]);

  // Dynamic language options - only show English and preferred language
  const allLanguageOptions = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'zh', label: '中文' },
    { value: 'vi', label: 'Tiếng Việt' }
  ];

  const languageOptions = allLanguageOptions.filter(option => 
    document.summaries && document.summaries[option.value]
  );

  const handlePreferredLanguageChange = async (languageCode: string) => {
    if (!profile || languageCode === profile.secondaryLanguage) return;
    
    const updatedProfile = {...profile, secondaryLanguage: languageCode};
    setProfile(updatedProfile);
    
    try {
      setSaving(true);
      await apiClient.profile.updateProfile(updatedProfile);
      
      // Update language context
      setLanguage(languageCode as SupportedLanguage);
      
      setOriginalProfile(updatedProfile);
      addNotification('success', t('profile.success.update'));
    } catch (err) {
      // Revert on error
      setProfile(originalProfile);
      addNotification('error', t('profile.error.update'));
    } finally {
      setSaving(false);
    }
  };

  // Handle language change - updates tab content and app language
  const handleLanguageChange = (lang: SupportedLanguage) => {
    handlePreferredLanguageChange(lang);
  };


  // Unified skip handler for the external button
  const handleSkip = () => {
    if (tutorialPhase === 'parent-rights') {
      setTutorialPhase('completed');
    } 
  };


  // Handle when user reaches the last slide in app tutorial
  // TODO : implement similar functionality in parent rights
  const handleLastSlideReached = () => {
    if (tutorialPhase === 'parent-rights') {
      setTutorialPhase('completed');
    }
  };

  // Parent Rights carousel data - internationalized using useLanguage hook
  const parentRightsSlideData = useMemo(() => {
    if (!translationsLoaded) return [];
    
    return [
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
    "Strengths":        { en: "Strengths",                       es: "Fortalezas",                    vi: "Điểm Mạnh",                        zh: "优势" },
    "Eligibility":      { en: "Eligibility",                     es: "Elegibilidad",                  vi: "Điều kiện hội đủ",                  zh: "资格条件" },
    "Present Levels":   { en: "Present Levels of Performance",   es: "Niveles Actuales de Desempeño", vi: "Mức Độ Hiệu Suất Hiện Tại",        zh: "当前表现水平" },
    "Goals":            { en: "Goals",                           es: "Objetivos",                     vi: "Mục Tiêu",                          zh: "目标" },
    "Services":         { en: "Services",                        es: "Servicios",                     vi: "Dịch Vụ",                           zh: "服务" },
    "Accommodations":   { en: "Accommodations",                  es: "Adaptaciones",                  vi: "Điều Chỉnh Hỗ Trợ",                zh: "调整措施" },
    "Placement":        { en: "Placement",                       es: "Ubicación",                     vi: "Vị Trí Sắp Xếp",                   zh: "安置" },
    "Key People":       { en: "Key People",                      es: "Personas Clave",                vi: "Những Người Chủ Chốt",             zh: "关键人员" },
    "Informed Consent": { en: "Consent",                         es: "Consentimiento Informado",      vi: "Chấp thuận sau khi được thông báo", zh: "知情同意" },
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
  const processLanguageSections = (doc: any, lang: string) => {
    // Only process sections when document is fully PROCESSED
    if (!doc || doc.status !== "PROCESSED") return;
    
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
          "zh": "缩写"
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
  const processDocumentSections = (doc: any) => {
    // Process English sections first
    processLanguageSections(doc, 'en');
    
    // Process preferred language if it's not English
    if (preferredLanguage !== 'en') {
      processLanguageSections(doc, preferredLanguage);
    }
  };

    useDocumentFetch({
    translationsLoaded,
    document,
    initialLoading,
    setDocument,
    setError,
    setInitialLoading,
    processDocumentSections
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

  // Check if document is processing (includes both initial processing and translations)
  const isProcessing = document && (document.status === "PROCESSING" || document.status === "PROCESSING_TRANSLATIONS");

  
  // Remove the separate isTranslating check since we're treating translation as part of processing

  // Reset tutorial phase when document status changes from processing
  useEffect(() => {
    if (!isProcessing) {
      setTutorialPhase('completed');
    } else {
      // Reset to app-tutorial when processing starts
      setTutorialPhase('parent-rights');
    }
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
      
      // Show success notification
      addNotification('success', 'PDF generated successfully!');
    } catch (error) {
      // console.error('PDF generation failed:', error);
      setPdfError(error instanceof Error ? error.message : 'Failed to generate PDF');
      
      // Show error notification
      addNotification('error', `PDF generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

    return (
      <>        
        {/* Summary Section */}
        {hasSummary ? (
          <>
          <div className="summary-updated-at">  
            {document.updatedAt && (
              <span>{t('summary.lastUpdate')} {TextHelper.formatUnixTimestamp(document.updatedAt, lang)}</span>
            )}
          </div>
            <h4 className="summary-header mt-4">
              {isEnglishTab ? 'IEP Summary' : t('summary.iepSummary')}
            </h4>
            <Card className="summary-content mb-3">
              <Card.Body>
                {(() => {
                  const fullContent = document.summaries[lang];
                  const { truncated, needsTruncation } = truncateContent(fullContent);
                  const isExpanded = isSummaryExpanded[lang];
                  const contentToShow = needsTruncation && !isExpanded ? truncated : fullContent;
                  
                  return (
                    <div className="markdown-content" onClick={handleContentClick}>
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
            {!isEnglishTab && (
              <div className="mt-3">
                <p className="mb-2">{t('summary.reuploadSuggestion')}</p>
                <Button 
                  variant="primary" 
                  size="sm"
                  onClick={() => navigate('/iep-documents')}
                >
                  {t('summary.reuploadButton')}
                </Button>
              </div>
            )}
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
                <Accordion.Item key={index} eventKey={index.toString()}>
                  <Accordion.Header>
                    {section.displayName}
                  </Accordion.Header>
                  <Accordion.Body>
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
            {!isEnglishTab && (
              <div className="mt-3">
                <p className="mb-2">{t('summary.reuploadSuggestion')}</p>
                <Button 
                  variant="primary" 
                  size="sm"
                  onClick={() => navigate('/iep-documents')}
                >
                  {t('summary.reuploadButton')}
                </Button>
              </div>
            )}
          </Alert>
        )}
      </>
    );
  };

  // Get tab title based on language code
  const getTabTitle = (languageCode: string) => {
    switch(languageCode) {
      case 'en': return t('summary.english');
      case 'es': return 'Español';
      case 'vi': return 'Tiếng Việt';
      case 'zh': return '中文';
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


  if(profile.showOnboarding){
    navigate('/');
    return null;
  }

  if(document && document.message === "No document found for this child") {
      navigate('/iep-documents');
  }

  // Processing Container - when document is being processed
  if (isProcessing) {
    // console.log("tutorialPhase", tutorialPhase);
    return (
      <ProcessingModal 
        error={error}
        tutorialPhase={tutorialPhase}
        t={t}
        parentRightsSlideData={parentRightsSlideData}
        onLastSlideReached={handleLastSlideReached}
        headerPinkTitle={t('rights.header.title.pink')}
        headerGreenTitle={t('rights.header.title.green')}
      />
    );
  }

  // If document fails the user is taken to the upload screen
  if (document && document.status === "FAILED") {
    navigate('/iep-documents');
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
              >
                {isGeneratingPDF ? (
                  <>
                    <Spinner animation="border" size="sm" className="me-2" />
                    Generating PDF...
                  </>
                ) : (
                  <>
                    <FontAwesomeIcon icon={faDownload} className="me-2" />
                    {t('common.save')}
                  </>
                )}
              </Button>
            )}
          </div>
          
          {/* Language Dropdown - Only show if more than one language available and not processing */}
          {!isProcessing && document && document.status === "PROCESSED" && languageOptions.length > 1 && (
            <Dropdown className='language-dropdown-toggle'>
              <Dropdown.Toggle variant="outline-primary" id="language-dropdown" size="sm">
                {(languageOptions.find(option => option.value === selectedLanguage)?.label || 'English').toUpperCase()}
              </Dropdown.Toggle>
              <Dropdown.Menu>
                {languageOptions.map(option => (
                  <Dropdown.Item 
                    key={option.value} 
                    onClick={() => handleLanguageChange(option.value as SupportedLanguage)}
                    active={selectedLanguage === option.value}
                  >
                    {option.label.toUpperCase()}
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
                        <h5>{t('summary.failed.title')}</h5>
                        <p>{t('summary.failed.message')}</p>
                      </Alert>
                    ) : 
                      <>
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
                        
                        {/* Show prominent alert when preferred language content is missing */}
                        {preferredLanguage !== 'en' && !hasContent(preferredLanguage) && hasContent('en') && (
                          <Alert variant="warning" className="mb-3">
                            <div className="d-flex align-items-start">
                              <FontAwesomeIcon icon={faLanguage} className="me-2 mt-1" />
                              <div className="flex-grow-1">
                                <h6 className="mb-2">{t('summary.noPreferredLanguageContent.title')}</h6>
                                <p className="mb-2">{t('summary.noPreferredLanguageContent.message')}</p>
                                <Button 
                                  variant="primary" 
                                  size="sm"
                                  onClick={() => navigate('/iep-documents')}
                                >
                                  {t('summary.reuploadButton')}
                                </Button>
                              </div>
                            </div>
                          </Alert>
                        )}
                        
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