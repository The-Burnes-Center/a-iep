/**
 * Which of a parent's children a screen is about.
 *
 * The answer lives in the URL (`?child=<childId>`), not in component state:
 * the bottom nav is a route change, so state that only lived in a page comes
 * back empty when the parent returns, and a page that quietly fell back to the
 * first child would then show or upload against the wrong one. A URL survives
 * that, survives a reload, and can be linked to.
 *
 * Without the multiChild feature, or with only one child, the parameter is
 * ignored and every screen is about the first child, exactly as before. That
 * keeps a single-child family (and staging's E2E, which is prod's only proxy)
 * on the path production runs.
 */

export const CHILD_QUERY_PARAM = 'child';

export interface ChildLike {
  childId?: string;
  name?: string | null;
}

export interface ActiveChild<C extends ChildLike> {
  child: C;
  /** Zero-based position in the profile's list, for "Child 2 of 3". */
  index: number;
  /** True when the URL asked for a child that is not on this profile. */
  requestedMissing: boolean;
}

/**
 * The child a screen is about: the one the URL names when that is allowed and
 * it is really on the profile; else the child last opened in this tab
 * (`rememberedId`), when it is still on the profile; else the first. Null when
 * there are none.
 *
 * The remembered child is what a link that names nobody means: the Summary
 * tab, or Support's "Show me around". Those used to open the first child,
 * whichever child the parent had just been reading.
 */
export const resolveActiveChild = <C extends ChildLike>(
  children: ReadonlyArray<C> | null | undefined,
  requestedId: string | null | undefined,
  multiChildEnabled: boolean,
  rememberedId?: string | null,
): ActiveChild<C> | null => {
  if (!children || children.length === 0) return null;
  const first = { child: children[0], index: 0, requestedMissing: false };
  if (!multiChildEnabled) return first;
  if (requestedId) {
    const index = children.findIndex((c) => c.childId === requestedId);
    if (index === -1) return { ...first, requestedMissing: true };
    return { child: children[index], index, requestedMissing: false };
  }
  const remembered = rememberedId ? children.findIndex((c) => c.childId === rememberedId) : -1;
  return remembered === -1 ? first : { child: children[remembered], index: remembered, requestedMissing: false };
};

/**
 * The child last opened in this tab: an id only, in sessionStorage, so it
 * goes with the tab and is cleared at sign-out (use-clear-cache-on-sign-out).
 * Storage that throws (a private window, blocked site data) means nothing is
 * remembered, which is the first-child behaviour from before.
 */
export const REMEMBERED_CHILD_KEY = 'aiep.activeChild';

export const readRememberedChild = (): string | null => {
  try {
    return window.sessionStorage.getItem(REMEMBERED_CHILD_KEY);
  } catch {
    return null;
  }
};

export const rememberChild = (childId: string | null): void => {
  try {
    if (childId) window.sessionStorage.setItem(REMEMBERED_CHILD_KEY, childId);
    else window.sessionStorage.removeItem(REMEMBERED_CHILD_KEY);
  } catch {
    // Not remembered; the next unnamed link opens the first child.
  }
};

/** True when the family has more than one child and the feature is on. */
export const isMultiChildFamily = (
  children: ReadonlyArray<ChildLike> | null | undefined,
  multiChildEnabled: boolean,
): boolean => multiChildEnabled && (children?.length ?? 0) > 1;

/**
 * `path` for this child. Single-child families get the bare path, so their
 * URLs are the ones production uses.
 */
export const pathForChild = (path: string, childId: string | undefined, isMultiChild: boolean): string =>
  isMultiChild && childId ? `${path}?${CHILD_QUERY_PARAM}=${encodeURIComponent(childId)}` : path;

/**
 * A dictionary string with values in it. The dictionaries carry `{name}`,
 * `{n}` and so on where each language wants them, so word order and
 * possessives are the translator's, never an English "'s" glued on in code.
 * Split-and-join rather than String.replace, so a `$&` in a child's name is
 * text, not a replacement pattern.
 */
export const fillTemplate = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(value), template);
