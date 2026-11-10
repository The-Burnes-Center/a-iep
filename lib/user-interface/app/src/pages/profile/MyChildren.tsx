import React, { useContext, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { IconPlus } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import Button from '../../components/ui/Button';
import { Notice, StatusTag, StatusTone } from '../../components/ui/feedback';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { PROFILE_QUERY_KEY } from '../../common/hooks/use-language-preference';
import { fillTemplate, pathForChild } from '../../common/active-child';
import { isPlaceholderChildName } from '../../common/features';
import { STEP } from '../../common/breadcrumb-steps';
import PageShell from '../../components/page/PageShell';
import PageLoading from '../../components/PageLoading';
import { Child } from '../../common/types';
import ChildrenHero from './ChildrenHero';
import { ChildDocumentState, MAX_CHILDREN, childDocumentState } from './my-children-status';
import './MyChildren.css';

/** Each document state as one of the shared status tones (words + icon). */
const STATUS_TONE: Record<ChildDocumentState, StatusTone> = {
  ready: 'ready',
  reading: 'working',
  failed: 'problem',
  none: 'neutral',
  unknown: 'problem',
};

/**
 * Every child on the account, what state each one's IEP is in, the one thing
 * to do next for each, and where to edit, remove or add a child. With the
 * multiChild feature on this replaces Account's "Your child's name" row, so
 * there is one place to manage children, whether a family has one or five.
 *
 * Each card's state comes from the server on every visit (the documents API,
 * per child), never from something remembered in the browser: the server owns
 * the state of server work.
 */
const MyChildren: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const { children, isMultiChild, isLoading } = useActiveChild();

  /** The child whose removal is being confirmed, if any. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [failedName, setFailedName] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  const documentQueries = useQueries({
    queries: children.map((child) => ({
      queryKey: ['child-document', child.childId],
      queryFn: () => new IEPDocumentClient(appContext).getMostRecentDocumentWithSummary(child.childId),
      enabled: Boolean(child.childId),
      retry: false,
    })),
  });

  // Move focus into the confirmation when it opens, so a keyboard or screen
  // reader user lands on the decision rather than behind it.
  useEffect(() => {
    if (confirmingId) confirmButtonRef.current?.focus();
  }, [confirmingId]);

  if (!isFeatureEnabled('multiChild')) return <Navigate to="/account-center" replace />;
  if (isLoading) return <PageLoading message={t('common.loading')} />;

  const displayName = (child: Child) =>
    isPlaceholderChildName(child.name) ? t('myChildren.unnamed') : child.name;
  const canRemove = children.length > 1;

  const removeChild = async (child: Child) => {
    if (!child.childId) return;
    const name = displayName(child);
    setRemovingId(child.childId);
    setFailedName(null);
    try {
      await new ApiClient(appContext).profile.removeChild(child.childId);
      await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
      setConfirmingId(null);
      setAnnouncement(fillTemplate(t('myChildren.removed'), { name }));
    } catch {
      // The cause is in the API's log; the parent gets what to do next.
      setFailedName(name);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <>
      <PageShell trail={[STEP.account, STEP.myChildren]} className="my-children-page">
        <ChildrenHero titleId="my-children-title" title={t('myChildren.title')} description={t('myChildren.intro')} />

        <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>
        {failedName && (
          <Notice tone="error" title={fillTemplate(t('myChildren.remove.failed'), { name: failedName })} />
        )}

        <ul className="my-children-list">
          {children.map((child, i) => {
            const query = documentQueries[i];
            const state = childDocumentState(query?.data, Boolean(query?.isError));
            const name = displayName(child);
            const childPath = (path: string) => pathForChild(path, child.childId, isMultiChild);
            const isConfirming = confirmingId === child.childId;
            const isRemoving = removingId === child.childId;
            return (
              <li key={child.childId ?? i} className="my-children-card" data-testid="my-children-card">
                <div className="my-children-card-head">
                  <span className="my-children-initial" aria-hidden="true">{name.trim().charAt(0).toUpperCase()}</span>
                  <span className="my-children-who">
                    <span className="my-children-name">{name}</span>
                    {child.schoolCity && child.schoolCity !== 'Not specified' && (
                      <span className="my-children-meta">{child.schoolCity}</span>
                    )}
                  </span>
                  {query?.isLoading ? (
                    <StatusTag tone="working">{t('common.loading')}</StatusTag>
                  ) : (
                    <StatusTag tone={STATUS_TONE[state]} data-testid="my-children-status">
                      {t(`myChildren.status.${state}`)}
                    </StatusTag>
                  )}
                </div>

                {!query?.isLoading && (
                  <CardAction state={state} name={name} childPath={childPath} onRetry={() => query?.refetch()} />
                )}

                {isConfirming ? (
                  <div className="my-children-confirm" role="group" aria-labelledby={`remove-title-${child.childId}`} data-testid="my-children-confirm">
                    <p id={`remove-title-${child.childId}`} className="my-children-confirm-title">
                      {fillTemplate(t('myChildren.remove.confirmTitle'), { name })}
                    </p>
                    <p className="my-children-confirm-body">{fillTemplate(t('myChildren.remove.confirmBody'), { name })}</p>
                    <div className="my-children-confirm-actions">
                      <Button
                        ref={confirmButtonRef as React.Ref<HTMLButtonElement>}
                        variant="danger"
                        onClick={() => removeChild(child)}
                        busy={isRemoving}
                        busyLabel={t('myChildren.remove.removing')}
                        data-testid="my-children-confirm-remove"
                      >
                        {fillTemplate(t('myChildren.remove.confirm'), { name })}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setConfirmingId(null)}
                        disabled={isRemoving}
                      >
                        {fillTemplate(t('myChildren.remove.keep'), { name })}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="my-children-manage">
                    <Button
                      variant="secondary"
                      to={`/account-center/children/edit?child=${encodeURIComponent(child.childId ?? '')}`}
                      aria-label={fillTemplate(t('myChildren.editLabel'), { name })}
                      data-testid="my-children-edit"
                    >
                      {t('myChildren.edit')}
                    </Button>
                    {canRemove && (
                      <Button
                        variant="secondary"
                        className="my-children-remove"
                        aria-label={fillTemplate(t('myChildren.removeLabel'), { name })}
                        onClick={() => { setFailedName(null); setConfirmingId(child.childId ?? null); }}
                        data-testid="my-children-remove"
                      >
                        {t('myChildren.remove')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {children.length < MAX_CHILDREN ? (
          <Link to="/account-center/children/add" className="my-children-add-tile" data-testid="my-children-add">
            <IconPlus size={20} stroke={2.5} aria-hidden="true" />
            {t('myChildren.add')}
          </Link>
        ) : (
          <Notice tone="info" title={t('myChildren.limit')} />
        )}
      </PageShell>
    </>
  );
};

interface CardActionProps {
  state: ChildDocumentState;
  name: string;
  childPath: (path: string) => string;
  onRetry: () => void;
}

/** The one next step for a child, by the state their IEP is in. */
const CardAction: React.FC<CardActionProps> = ({ state, name, childPath, onRetry }) => {
  const { t } = useLanguage();
  const action = (key: string) => fillTemplate(t(key), { name });

  switch (state) {
    case 'ready':
      return <Button fullWidth to={childPath('/summary-and-translations')}>{action('myChildren.action.view')}</Button>;
    case 'reading':
      return (
        <>
          <p className="my-children-hint">{t('myChildren.reading.hint')}</p>
          <Button fullWidth variant="secondary" to={childPath('/summary-and-translations')}>{action('myChildren.action.progress')}</Button>
        </>
      );
    case 'failed':
      return (
        <>
          <p className="my-children-hint">{t('myChildren.failed.hint')}</p>
          <Button fullWidth to={childPath('/iep-documents')}>{action('myChildren.action.uploadAgain')}</Button>
        </>
      );
    case 'none':
      return <Button fullWidth to={childPath('/iep-documents')}>{action('myChildren.action.upload')}</Button>;
    default:
      return (
        <Button fullWidth variant="secondary" onClick={onRetry}>
          {t('myChildren.action.retry')}
        </Button>
      );
  }
};

export default MyChildren;
