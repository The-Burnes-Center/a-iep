import React from 'react';
import { Breadcrumb } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useLanguage } from '../common/language-context';
import './Breadcrumbs.css';

/** One step of a trail. */
export interface Crumb {
  /**
   * Translation key for the label. A key rather than a string: `t()` is
   * `translations[key] || key`, so a caller that passed already-translated
   * text would silently stop re-translating when the parent changes language
   * mid-screen, which the language selector in the onboarding bar invites.
   */
  labelKey: string;
  /**
   * Where the crumb leads. Left off on the LAST crumb, which is the page the
   * parent is already on and is marked `aria-current="page"` instead.
   */
  to?: string;
}

interface BreadcrumbsProps {
  trail: Crumb[];
}

/**
 * The one navigation control in this app: a trail of where the parent is, with
 * every step but the last one a link back to it. There is no Back button
 * anywhere; a screen that wants to offer a way back names the step in its
 * trail.
 *
 * Eight screens had their own copy of this markup and onboarding had a BACK
 * pill instead, so a parent met two different idioms depending which half of
 * the app they were in. Three things that were wrong in all eight copies are
 * fixed once here:
 *
 *  - the <nav> label was react-bootstrap's default, the English word
 *    "breadcrumb", in an app that ships five languages;
 *  - the crumbs were `<Breadcrumb.Item onClick>` with no href, which renders
 *    an anchor with role="button": focusable, but not a link, so a parent
 *    could not open a step in a new tab or see where it went;
 *  - nothing marked the current page, because `active` was applied by hand
 *    and an eighth copy would eventually forget it.
 *
 * Trails here are TWO items, `<previous step> > <this step>`. On the account
 * screens that is the section hub and the page. On onboarding, which is a
 * linear flow rather than a hierarchy, the only true ancestor of a step is the
 * step before it, and the walked-so-far trail (five items by the PDF question)
 * does not fit the 375px phone these parents are on; two items is that trail
 * truncated the way trails are normally truncated on mobile, and it is the
 * shape the rest of the app already uses.
 */
export default function Breadcrumbs({ trail }: BreadcrumbsProps) {
  const { t } = useLanguage();

  if (trail.length === 0) return null;

  return (
    <div className="breadcrumb-container">
      <Breadcrumb label={t('breadcrumb.label')}>
        {trail.map((crumb, index) => {
          // The last crumb is the current page. A crumb with no destination is
          // treated the same way, so a screen that cannot name its previous
          // step degrades to "you are here" rather than to a dead link.
          const isCurrent = index === trail.length - 1 || !crumb.to;

          if (isCurrent) {
            return (
              <Breadcrumb.Item key={crumb.labelKey} active>
                {t(crumb.labelKey)}
              </Breadcrumb.Item>
            );
          }

          return (
            <Breadcrumb.Item
              key={crumb.labelKey}
              linkAs={Link}
              linkProps={{ to: crumb.to }}
            >
              {t(crumb.labelKey)}
            </Breadcrumb.Item>
          );
        })}
      </Breadcrumb>
    </div>
  );
}
