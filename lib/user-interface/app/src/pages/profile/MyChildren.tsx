import React, { useContext } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Alert, Button } from 'react-bootstrap';
import { useQueries } from '@tanstack/react-query';
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconClock, IconPlus } from '@tabler/icons-react';
import { AppContext } from '../../common/app-context';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { fillTemplate, pathForChild } from '../../common/active-child';
import { isPlaceholderChildName } from '../../common/features';
import { STEP } from '../../common/breadcrumb-steps';
import Breadcrumbs from '../../components/Breadcrumbs';
import PageLoading from '../../components/PageLoading';
import { Child } from '../../common/types';
import { ChildDocumentState, MAX_CHILDREN, childDocumentState } from './my-children-status';
import './MyChildren.css';

/** Status in words and an icon, never colour alone. */
const STATUS_ICON: Record<ChildDocumentState, React.ReactNode> = {
  ready: <IconCircleCheck size={18} stroke={2} aria-hidden="true" />,
  reading: <IconClock size={18} stroke={2} aria-hidden="true" />,
  failed: <IconAlertTriangle size={18} stroke={2} aria-hidden="true" />,
  none: <IconCircleDashed size={18} stroke={2} aria-hidden="true" />,
  unknown: <IconAlertTriangle size={18} stroke={2} aria-hidden="true" />,
};

/**
 * Every child on the account, what state each one's IEP is in, and the one
 * thing to do next for each. Reached from Account and from the child bar's
 * "Switch child", so a family with one child never has to see it.
 *
 * Each card's state comes from the server on every visit (the documents API,
 * per child), never from something remembered in the browser: the server owns
 * the state of server work.
 */
const MyChildren: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const appContext = useContext(AppContext);
  const { children, isMultiChild, isLoading } = useActiveChild();

  const documentQueries = useQueries({
    queries: children.map((child) => ({
      queryKey: ['child-document', child.childId],
      queryFn: () => new IEPDocumentClient(appContext).getMostRecentDocumentWithSummary(child.childId),
      enabled: Boolean(child.childId),
      retry: false,
    })),
  });

  if (!isFeatureEnabled('multiChild')) return <Navigate to="/account-center" replace />;
  if (isLoading) return <PageLoading message={t('common.loading')} />;

  const displayName = (child: Child) =>
    isPlaceholderChildName(child.name) ? t('myChildren.unnamed') : child.name;

  return (
    <>
      <Breadcrumbs trail={[STEP.account, STEP.myChildren]} />
      <div className="my-children-page">
        <h1 className="my-children-title">{t('myChildren.title')}</h1>
        <p className="my-children-intro">{t('myChildren.intro')}</p>

        <ul className="my-children-list">
          {children.map((child, i) => {
            const query = documentQueries[i];
            const state = childDocumentState(query?.data, Boolean(query?.isError));
            const name = displayName(child);
            const childPath = (path: string) => pathForChild(path, child.childId, isMultiChild);
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
                    <span className="my-children-status is-checking">{t('common.loading')}</span>
                  ) : (
                    <span className={`my-children-status is-${state}`} data-testid="my-children-status">
                      {STATUS_ICON[state]}
                      {t(`myChildren.status.${state}`)}
                    </span>
                  )}
                </div>
                {!query?.isLoading && (
                  <CardAction state={state} name={name} childPath={childPath} onRetry={() => query?.refetch()} />
                )}
              </li>
            );
          })}
        </ul>

        {children.length < MAX_CHILDREN ? (
          <Link to="/account-center/children/add" className="btn btn-outline-secondary aiep-button my-children-add" data-testid="my-children-add">
            <IconPlus size={18} stroke={2.5} aria-hidden="true" className="me-2" />
            {t('myChildren.add')}
          </Link>
        ) : (
          <Alert variant="info">{t('myChildren.limit')}</Alert>
        )}
      </div>
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
  const primary = 'btn btn-primary aiep-button my-children-action';

  switch (state) {
    case 'ready':
      return <Link className={primary} to={childPath('/summary-and-translations')}>{action('myChildren.action.view')}</Link>;
    case 'reading':
      return (
        <>
          <p className="my-children-hint">{t('myChildren.reading.hint')}</p>
          <Link className="my-children-link" to={childPath('/summary-and-translations')}>{action('myChildren.action.progress')}</Link>
        </>
      );
    case 'failed':
      return (
        <>
          <p className="my-children-hint">{t('myChildren.failed.hint')}</p>
          <Link className={primary} to={childPath('/iep-documents')}>{action('myChildren.action.uploadAgain')}</Link>
        </>
      );
    case 'none':
      return <Link className={primary} to={childPath('/iep-documents')}>{action('myChildren.action.upload')}</Link>;
    default:
      return (
        <Button variant="outline-secondary" className="aiep-button my-children-action" onClick={onRetry}>
          {t('myChildren.action.retry')}
        </Button>
      );
  }
};

export default MyChildren;
