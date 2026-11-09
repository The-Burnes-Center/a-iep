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
 * it is really on the profile, otherwise the first. Null when there are none.
 */
export const resolveActiveChild = <C extends ChildLike>(
  children: ReadonlyArray<C> | null | undefined,
  requestedId: string | null | undefined,
  multiChildEnabled: boolean,
): ActiveChild<C> | null => {
  if (!children || children.length === 0) return null;
  if (!multiChildEnabled || !requestedId) return { child: children[0], index: 0, requestedMissing: false };
  const index = children.findIndex((c) => c.childId === requestedId);
  if (index === -1) return { child: children[0], index: 0, requestedMissing: true };
  return { child: children[index], index, requestedMissing: false };
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
