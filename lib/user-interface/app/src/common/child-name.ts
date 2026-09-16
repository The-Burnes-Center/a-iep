/**
 * What counts as a child's name, for the one screen that asks for it.
 *
 * The same rule runs server-side in user-profile-handler
 * (`validate_child_name`), and the two have to stay identical: a name this
 * file accepts and the API then rejects reaches the parent as a generic "could
 * not save", with nothing on screen telling them what to change.
 *
 * The allow-list is Unicode, not Latin. Four of the five languages we ship in
 * are Spanish, Chinese, Vietnamese and Arabic, so `[A-Za-z]` would turn a
 * correctly typed name into an error for most of the families using this.
 * Combining marks (`\p{M}`) are load-bearing for the same reason: Vietnamese
 * and Arabic write tone and vowels as separate code points, so a decomposed
 * "Nguyễn" is letters interleaved with marks rather than precomposed ones.
 *
 * What it rejects is a name with no letter in it at all -- "123", "!!!", "."
 * -- which is what a parent could save before this existed. Digits alongside
 * letters are allowed: a parent distinguishing two children as "Anna 2" is
 * naming their child, not making a mistake, and refusing it leaves them with
 * no way forward. Symbols, emoji and control characters are still refused.
 * `\1` is in that set, and that is not cosmetic -- it used to reach a regex
 * replacement server-side.
 */

/** Long enough for any real name; short enough to keep a paste out of the field. */
export const CHILD_NAME_MAX_LENGTH = 64;

export type ChildNameError = 'required' | 'tooLong' | 'invalid';

/**
 * Letters, combining marks, decimal digits, and the punctuation a name can
 * carry: a space, both hyphens and both apostrophes (a phone keyboard
 * autocorrects to the curly ones, and a parent who got one that way is not
 * making a mistake), and the period that ends an initial. Escaped rather than
 * written literally: the two hyphens and the two apostrophes are
 * indistinguishable on screen.
 */
const ALLOWED_CHARACTERS = /^[\p{L}\p{M}\p{Nd} \-\u2010'\u2019.]+$/u;

/** "123" and "." are not names: something in there has to be a letter. */
const HAS_LETTER = /\p{L}/u;

/** Trim, then collapse every internal run of whitespace to a single space. */
export const normalizeChildName = (raw: string): string =>
  (raw ?? '').trim().replace(/\s+/g, ' ');

/**
 * The reason this name cannot be saved, or null when it can.
 *
 * Checked in the order the messages are written: an over-long string of digits
 * is reported as too long, the same way the API reports it.
 */
export const validateChildName = (raw: string): ChildNameError | null => {
  const name = normalizeChildName(raw);
  if (name === '') return 'required';
  if (name.length > CHILD_NAME_MAX_LENGTH) return 'tooLong';
  if (!HAS_LETTER.test(name)) return 'invalid';
  if (!ALLOWED_CHARACTERS.test(name)) return 'invalid';
  return null;
};
