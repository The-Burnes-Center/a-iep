import React from 'react';
import Button from './ui/Button';
import { useLanguage } from '../common/language-context';
import { useActiveChild } from '../common/hooks/use-active-child';
import { fillTemplate } from '../common/active-child';
import './ChildBar.css';

/**
 * Whose IEP this screen is about, for a family with more than one child.
 *
 * A parent moving between children must never have to guess which one a
 * summary, a translation or an upload belongs to, so every screen about one
 * child carries this: the child's initial and "Maya's IEP", and a way to
 * switch. The name is the whole message. A count like "Child 2 of 3" was
 * dropped on purpose: it is the app numbering records, not how a parent
 * thinks about their own children.
 *
 * Renders nothing for a family with one child or with the multiChild feature
 * off, so those screens are exactly what production shows. Hidden on the
 * processing takeover, which carries the name in its own status band.
 */
const ChildBar: React.FC = () => {
  const { t } = useLanguage();
  const { child, isMultiChild } = useActiveChild();
  if (!isMultiChild || !child) return null;

  const name = child.name ?? '';
  return (
    <section className="child-bar" aria-label={t('childBar.region')} data-testid="child-bar">
      <span className="child-bar-initial" aria-hidden="true">{name.trim().charAt(0).toUpperCase()}</span>
      <strong className="child-bar-name" data-testid="child-bar-name">
        {fillTemplate(t('childBar.whoseIep'), { name })}
      </strong>
      <Button
        variant="secondary"
        className="child-bar-switch"
        to="/account-center/children"
        aria-label={t('childBar.switchLabel')}
        data-testid="child-bar-switch"
      >
        {t('childBar.switch')}
      </Button>
    </section>
  );
};

export default ChildBar;
