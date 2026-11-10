import React, { useContext, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { PROFILE_QUERY_KEY } from '../../common/hooks/use-language-preference';
import { STEP } from '../../common/breadcrumb-steps';
import { afterChildCount } from '../../common/onboarding-next';
import type { UserProfile } from '../../common/types';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import PageLoading from '../../components/PageLoading';
import Button from '../../components/ui/Button';
import { Radios } from '../../components/ui/fields';
import { Notice } from '../../components/ui/feedback';
import './survey.css';

/** "4 or more" is stored as 4: the number only decides whether to offer a next child. */
const COUNT_OPTIONS = ['1', '2', '3', '4'] as const;

/**
 * Onboarding's "how many of your children have an IEP?", asked once, after
 * consent. It sets the family's expectations ("we'll start with one") and
 * lets the end of a summary offer the next child. It never limits anything:
 * a family can add children whatever they answered.
 */
const ChildCount: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => new ApiClient(appContext).profile.getProfile() as Promise<UserProfile>,
  });
  const [count, setCount] = useState<string | undefined>(undefined);
  const [showMissing, setShowMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  if (!isFeatureEnabled('onboardingSurvey')) return <Navigate to="/how-to-use-the-tool" replace />;
  if (profileQuery.isLoading) return <PageLoading message={t('common.loading')} />;

  const answered = count ?? (profileQuery.data?.iepChildCount ? String(Math.min(profileQuery.data.iepChildCount, 4)) : undefined);

  const handleContinue = async () => {
    if (!answered) {
      setShowMissing(true);
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      const iepChildCount = Number(answered);
      await new ApiClient(appContext).profile.updateProfile({ iepChildCount });
      // A fresh read, not a patch of the cached copy: that copy can date from
      // earlier in onboarding, and patching it marks it fresh for five more
      // minutes (see pages/profile/onboarding-cache.test.tsx).
      void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
      const next = afterChildCount(profileQuery.data, isFeatureEnabled);
      navigate(next.path, next.state ? { state: next.state } : undefined);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell trail={[STEP.consent, STEP.yourChildren]} className="child-count-page">
      <PageHero titleId="child-count-title" title={t('childCount.title')} description={t('childCount.intro')} showFaces={false} />
      <section className="page-card">
        {showMissing && !answered && (
          <Notice tone="error" data-testid="child-count-missing">{t('childCount.missing')}</Notice>
        )}
        {saveFailed && <Notice tone="error" title={t('childCount.saveFailed')} />}
        <Radios
          name="iep-child-count"
          legend={t('childCount.legend')}
          options={COUNT_OPTIONS.map((value) => ({
            value,
            label: t(`childCount.option.${value}`),
          }))}
          value={answered}
          onChange={(value) => { setCount(value); setShowMissing(false); }}
        />
        <p className="survey-note">{t('childCount.later')}</p>
        <Button fullWidth busy={saving} busyLabel={t('common.saving')} onClick={handleContinue} data-testid="child-count-continue">
          {t('common.continue')}
        </Button>
      </section>
    </PageShell>
  );
};

export default ChildCount;
