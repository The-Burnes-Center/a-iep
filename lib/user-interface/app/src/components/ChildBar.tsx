import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../common/language-context';
import { useActiveChild } from '../common/hooks/use-active-child';
import { fillTemplate } from '../common/active-child';
import './ChildBar.css';

/**
 * Whose IEP this screen is about, for a family with more than one child.
 *
 * A parent switching between children must never have to guess which one a
 * summary, a translation or an upload belongs to, so every screen about one
 * child carries this bar: the child's initial and name, where they sit in the
 * family, and a way to switch. Children are told apart by name and initial,
 * not colour.
 *
 * Renders nothing for a family with one child or with the multiChild feature
 * off, so those screens are exactly what production shows.
 */
const ChildBar: React.FC = () => {
  const { t } = useLanguage();
  const { child, index, children, isMultiChild } = useActiveChild();
  if (!isMultiChild || !child) return null;

  const name = child.name ?? '';
  return (
    <section className="child-bar" aria-label={t('childBar.region')} data-testid="child-bar">
      <span className="child-bar-initial" aria-hidden="true">{name.trim().charAt(0).toUpperCase()}</span>
      <span className="child-bar-who">
        <strong className="child-bar-name" data-testid="child-bar-name">
          {fillTemplate(t('childBar.whoseIep'), { name })}
        </strong>
        <span className="child-bar-position">
          {fillTemplate(t('childBar.position'), { n: String(index + 1), total: String(children.length) })}
        </span>
      </span>
      <Link className="child-bar-switch" to="/account-center/children" data-testid="child-bar-switch">
        {t('childBar.switch')}
      </Link>
    </section>
  );
};

export default ChildBar;
