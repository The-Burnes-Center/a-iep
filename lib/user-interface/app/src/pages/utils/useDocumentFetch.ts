import { useEffect, useRef, useContext, useState } from 'react';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { IEPDocument } from '../../common/types';
import { usePollingManager } from './polling-utility';
import { AppContext } from '../../common/app-context';


// Raw document payload returned by the documents API: sections arrive as
// { title, content, page_numbers } and are reshaped into IEPSection objects
// by the page-level processDocumentSections callback.
export interface FetchedIEPDocument extends Partial<Omit<IEPDocument, 'sections'>> {
  sections?: {
    [lang: string]: Array<{
      title?: string;
      content?: string;
      page_numbers?: number[];
    }>;
  };
}

/**
 * How many consecutive failed reads keep the retry interval alive.
 *
 * Only used when the last status we heard from the server was terminal (or we
 * never got one). A document the server said was still processing keeps being
 * polled for as long as the parent stays on the page, because that is the wait
 * they are actually here for.
 */
const MAX_CONSECUTIVE_FETCH_RETRIES = 5;

interface UseDocumentFetchParams {
  translationsLoaded: boolean;
  document: IEPDocument;
  initialLoading: boolean;
  setDocument: React.Dispatch<React.SetStateAction<IEPDocument>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setInitialLoading: React.Dispatch<React.SetStateAction<boolean>>;
  processDocumentSections: (doc: FetchedIEPDocument) => void;
  /**
   * Already-translated wording for "we could not read the document".
   *
   * Passed in rather than looked up here so the hook stays free of the
   * language context, and so `error` is a renderable string everywhere the
   * page already renders it.
   */
  loadErrorMessage: string;
  /**
   * Keep polling even when the fetched status looks terminal, and refetch as
   * soon as this flips.
   *
   * Set while an on-demand translation is running: the request puts the
   * document back into PROCESSING_TRANSLATIONS server-side, but the read that
   * immediately follows can still come back PROCESSED, and without this the
   * poller would never start — leaving the page waiting on an update that never
   * arrives. Flipping it back to false makes the next cycle stop the interval.
   */
  forcePolling?: boolean;
}

export const useDocumentFetch = ({
  translationsLoaded,
  initialLoading,
  setDocument,
  setError,
  setInitialLoading,
  processDocumentSections,
  loadErrorMessage,
  forcePolling = false
}: UseDocumentFetchParams) => {
  const isFirstRender = useRef<boolean>(true);

  const [refreshCounter, setRefreshCounter] = useState<number>(0);

  /**
   * The last status the SERVER gave us, kept across ticks.
   *
   * The effect's cleanup stops the interval on every dependency change, and
   * `refreshCounter` is a dependency, so each poll tick tears the interval down
   * and depends on the next read to rebuild it. Deciding that from a local
   * `retrievedDocument` meant one thrown fetch ended the wait permanently: a
   * parent watching a processing document waited forever, with no error and no
   * change on screen. The server owns the state of server work, so the decision
   * is made from the last thing the server said, not from whether this one read
   * happened to succeed.
   */
  const lastKnownDocumentRef = useRef<Pick<IEPDocument, 'status'> | null>(null);
  const consecutiveFailuresRef = useRef<number>(0);


  const { pollingManager } = usePollingManager();

    const appContext = useContext(AppContext);
    const apiClient = new IEPDocumentClient(appContext);

  useEffect(() => {
    if (!translationsLoaded) return;
    
    const fetchDocument = async () => {
      if (isFirstRender.current) {
        isFirstRender.current = false;
      }
      
      try {
        const retrievedDocument = await apiClient.getMostRecentDocumentWithSummary();
        // console.log("Fetched document data:", retrievedDocument);
        
        if (retrievedDocument) {

          if(retrievedDocument.message && retrievedDocument.message === "No document found for this child") {
            setDocument(prev => ({
              ...prev,
              message: retrievedDocument.message
            }));
          }
          
          setDocument(prev => {         
            if (!prev || 
                prev.status !== retrievedDocument.status || 
                prev.createdAt !== retrievedDocument.createdAt) {
                  
              // console.log("if (prev) is true");
              // Log timing when status changes
              const uploadStartTime = localStorage.getItem('iep-upload-start-time');
              if (uploadStartTime) {
                if (retrievedDocument.status === 'PROCESSING' && prev.status !== 'PROCESSING') {
                  // console.log(`🔄 Document processing started after ${elapsedSeconds} seconds`);
                  // console.log(`⏱️ OCR and analysis began at ${new Date(currentTime).toLocaleTimeString()}`);
                } else if (retrievedDocument.status === 'PROCESSING_TRANSLATIONS' && prev.status !== 'PROCESSING_TRANSLATIONS') {
                  // console.log(`📝 English data available after ${elapsedSeconds} seconds`);
                  // console.log(`⏱️ English analysis completed at ${new Date(currentTime).toLocaleTimeString()}`);
                } else if (retrievedDocument.status === 'PROCESSED' && prev.status !== 'PROCESSED') {
                  // console.log(`🌍 Complete translated data available after ${elapsedSeconds} seconds`);
                  // console.log(`⏱️ Full processing completed at ${new Date(currentTime).toLocaleTimeString()}`);
                  // Clear the start time since processing is complete
                  localStorage.removeItem('iep-upload-start-time');
                }
              }
              
              return {
                ...retrievedDocument,
                sections: {
                  ...prev.sections, // Keep existing processed sections
                  ...(retrievedDocument.sections || {}) // Add new sections if available
                }
              };
            }
            return prev;
          });
          
          if (retrievedDocument.status === "PROCESSING_TRANSLATIONS" || retrievedDocument.status === "PROCESSED") {
            
            setDocument(prev => ({
              ...prev, 
              summaries: retrievedDocument.summaries,
              document_index: retrievedDocument.document_index
            }));
            
            // Process sections (this will process English sections when PROCESSING_TRANSLATIONS, and all sections when PROCESSED)
            processDocumentSections(retrievedDocument);
          }
        } else {
          // console.log("else (retrievedDocument) is true");
          // Clear document data if no document found
          setDocument(prev => ({
            ...prev,
            documentId: undefined,
            documentUrl: undefined,
            status: undefined,
            message: '',
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
          }));
        }
        
        lastKnownDocumentRef.current = retrievedDocument ?? null;
        consecutiveFailuresRef.current = 0;
        setError(null);
      } catch (err) {
        consecutiveFailuresRef.current += 1;
        // The error itself only — never the response body, which is the
        // document. A swallowed failure here left the parent looking at "No
        // summary available" and a Re-upload button for a healthy document.
        console.error('Could not read the IEP document:', err);
        setError(loadErrorMessage);
      } finally {
        // Runs on both paths on purpose: see lastKnownDocumentRef above. A
        // failed read keeps the interval alive so the next tick retries, and
        // once a read succeeds the status rule takes over again and stops it.
        const shouldRetryAfterFailure =
          consecutiveFailuresRef.current > 0 &&
          consecutiveFailuresRef.current <= MAX_CONSECUTIVE_FETCH_RETRIES;

        pollingManager.startPollingIfProcessing(lastKnownDocumentRef.current, () => {
          setRefreshCounter(prev => prev + 1);
        }, forcePolling || shouldRetryAfterFailure);

        if (initialLoading) {
          setInitialLoading(false);
        }
      }
    };
    
    fetchDocument();
    
    // Clean up interval
    return () => {
      pollingManager.stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch is driven by refreshCounter/translationsLoaded/forcePolling only; apiClient, pollingManager and the callbacks are recreated every render
  }, [refreshCounter, translationsLoaded, forcePolling]);
};