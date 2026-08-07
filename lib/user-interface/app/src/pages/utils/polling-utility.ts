import { useRef } from 'react';
import { IEPDocument } from '../../common/types';
import { shouldPollForUpdates } from './translation-flow.mjs';

export class PollingManager {
  private pollingIntervalRef: React.MutableRefObject<NodeJS.Timeout | null>;

  constructor(pollingIntervalRef: React.MutableRefObject<NodeJS.Timeout | null>) {
    this.pollingIntervalRef = pollingIntervalRef;
  }

  // Function to start polling if document is processing.
  //
  // `forcePolling` keeps the same single interval running when the caller knows
  // work is in flight that the fetched status has not caught up with yet (an
  // on-demand translation request); the decision itself lives in
  // ./translation-flow so it can be unit tested.
  startPollingIfProcessing = (
    doc: Pick<IEPDocument, 'status'> | null,
    onPoll: () => void,
    forcePolling = false
  ) => {
    if (this.pollingIntervalRef.current) {
      clearInterval(this.pollingIntervalRef.current);
      this.pollingIntervalRef.current = null;
    }

    if (shouldPollForUpdates(doc?.status, forcePolling)) {
      // console.log(`Document is ${doc.status}. Starting polling...`);
      this.pollingIntervalRef.current = setInterval(() => {
        // console.log("Polling for updates...");
        onPoll();
      }, 5000);
    }
  };

  // Function to stop polling
  stopPolling = () => {
    if (this.pollingIntervalRef.current) {
      clearInterval(this.pollingIntervalRef.current);
      this.pollingIntervalRef.current = null;
    }
  };
}

// Hook to use polling manager
export const usePollingManager = () => {
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingManager = new PollingManager(pollingIntervalRef);

  return {
    pollingManager,
    pollingIntervalRef
  };
};