import React from 'react';
import { Alert, Button, Container } from 'react-bootstrap';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../common/language-context';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  t: (key: string) => string;
  /**
   * Changing this clears the caught error and re-renders the children.
   *
   * React keeps the fallback mounted for the life of the component, so
   * without this a parent stays on the error screen even after the route
   * changes underneath it. The app passes the pathname. Note the in-app
   * bottom nav is mounted per page, so it is INSIDE the subtree the fallback
   * replaces: what this actually rescues is the browser's back button, and
   * the buttons below are what a parent has on screen.
   */
  resetKey?: string;
  /**
   * Leaves for a page that is known to work.
   *
   * Reloading alone is a dead end for anything deterministic: the same URL
   * throws the same way and the parent loops. /iep-documents is where
   * DocumentFailureState sends people for the same reason -- it lists the
   * current document and the uploader together.
   */
  onGoToDocuments: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  resetKey?: string;
}

/**
 * Last line of defence between a render-time exception and a blank page.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so one bad field in one component takes down the whole app. That is not a
 * hypothetical: a legacy document whose summary came back as an object rather
 * than a string reached `.split`, and the parent got a white screen with a
 * healthy 200 in the network tab and no way to tell whether the fault was
 * theirs, ours, or their connection.
 *
 * The specific defect is fixed at both ends (the migration no longer writes
 * that shape, and the summary page type-checks the field). This exists for
 * the next one. A parent should always get a sentence and a way forward.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, resetKey: undefined };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { hasError: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // The browser has already printed this uncaught error to the console, so
    // repeating it exposes nothing new. Keep it to the error and the
    // component stack: never re-log the props or state that produced it,
    // which on this screen would be the document.
    console.error(
      'Unhandled render error:',
      error?.name,
      error?.message,
      errorInfo?.componentStack,
    );
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const { t, onGoToDocuments } = this.props;
    return (
      <Container className="mt-4 mb-5">
        <Alert variant="danger" data-testid="app-error-boundary">
          <Alert.Heading as="h1" style={{ fontSize: '1.5rem' }}>
            {t('errorBoundary.title')}
          </Alert.Heading>
          <p>{t('errorBoundary.message')}</p>
          <div className="d-flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              {t('common.tryAgain')}
            </Button>
            <Button variant="outline-secondary" onClick={onGoToDocuments}>
              {t('summary.failed.goToDocuments')}
            </Button>
          </div>
        </Alert>
      </Container>
    );
  }
}

/**
 * The boundary as the app mounts it: translated, and reset by navigation.
 *
 * Split in two because a class component cannot call hooks, and the fallback
 * has to be readable in the parent's own language like every other string on
 * screen. Mounted inside LanguageProvider and BrowserRouter, so if `t` itself
 * is unavailable the raw key renders, which is the same failure mode as the
 * rest of the app rather than a new one.
 */
const AppErrorBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <ErrorBoundary
      t={t}
      resetKey={location.pathname}
      onGoToDocuments={() => navigate('/iep-documents')}
    >
      {children}
    </ErrorBoundary>
  );
};

export default AppErrorBoundary;
