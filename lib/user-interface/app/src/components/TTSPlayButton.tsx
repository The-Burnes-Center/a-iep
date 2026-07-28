import React, { useContext, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faVolumeHigh, faPause, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { AppContext } from '../common/app-context';
import { IEPDocumentClient } from '../common/api-client/iep-document-client';
import { useLanguage } from '../common/language-context';
import './TTSPlayButton.css';

interface TTSPlayButtonProps {
  iepId?: string;
  language: string;
  target: 'summary' | 'section';
  sectionName?: string;
  className?: string;
}

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

// Only one audio element plays at a time across all buttons on the page
let activeAudio: HTMLAudioElement | null = null;

// Refresh the presigned URL well before its 1h expiry
const URL_MAX_AGE_MS = 50 * 60 * 1000;

const TTSPlayButton: React.FC<TTSPlayButtonProps> = ({
  iepId,
  language,
  target,
  sectionName,
  className
}) => {
  const { t } = useLanguage();
  const appContext = useContext(AppContext);
  const [state, setState] = useState<PlaybackState>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fetchedAtRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        // Detach handlers first so the pause below can't setState on an
        // unmounted component
        audioRef.current.onpause = null;
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.pause();
        if (activeAudio === audioRef.current) {
          activeAudio = null;
        }
        audioRef.current = null;
      }
    };
  }, []);

  if (!iepId) {
    return null;
  }

  const startPlayback = (audio: HTMLAudioElement) => {
    if (activeAudio && activeAudio !== audio) {
      activeAudio.pause();
    }
    activeAudio = audio;
    audio
      .play()
      .then(() => setState('playing'))
      .catch(() => setState('error'));
  };

  const handleClick = async () => {
    if (state === 'loading') {
      return;
    }

    if (state === 'playing' && audioRef.current) {
      audioRef.current.pause();
      setState('paused');
      return;
    }

    const existingAudio = audioRef.current;
    const urlIsFresh = Date.now() - fetchedAtRef.current < URL_MAX_AGE_MS;
    if (state === 'paused' && existingAudio && urlIsFresh) {
      startPlayback(existingAudio);
      return;
    }

    setState('loading');
    try {
      const apiClient = new IEPDocumentClient(appContext);
      const response = await apiClient.getDocumentAudio(iepId, language, target, sectionName);

      const audio = new Audio(response.url);
      audio.onended = () => setState('idle');
      audio.onerror = () => setState('error');
      // Any pause that isn't the track ending must flip this button back to
      // resumable. Without this, another button starting playback (which
      // pauses this element via startPlayback), or an OS media-key pause,
      // leaves this button stuck rendering "playing" alongside the new one.
      audio.onpause = () => {
        if (!audio.ended) {
          setState('paused');
        }
      };
      audioRef.current = audio;
      fetchedAtRef.current = Date.now();
      startPlayback(audio);
    } catch {
      setState('error');
    }
  };

  const label =
    state === 'playing' ? t('tts.pause')
    : state === 'loading' ? t('tts.generating')
    : state === 'error' ? t('tts.error')
    : t('tts.listen');

  return (
    <Button
      variant="outline-secondary"
      size="sm"
      className={`tts-play-button ${state === 'error' ? 'tts-play-button-error' : ''} ${className || ''}`}
      onClick={handleClick}
      disabled={state === 'loading'}
      aria-label={label}
      title={label}
    >
      {state === 'loading' ? (
        <Spinner animation="border" size="sm" role="status" aria-hidden="true" />
      ) : state === 'playing' ? (
        <FontAwesomeIcon icon={faPause} />
      ) : state === 'error' ? (
        <FontAwesomeIcon icon={faRotateRight} />
      ) : (
        <FontAwesomeIcon icon={faVolumeHigh} />
      )}
    </Button>
  );
};

export default TTSPlayButton;
