/**
 * Where to send a parent after they sign in.
 *
 * ProtectedRoute remembers the page a parent asked for, and CustomLogin
 * returns them there once they are signed in. That remembered value comes
 * from the address bar, so it is only followed when it is a path inside this
 * app; anything else sends the parent to the default page instead.
 */

const DEFAULT_RETURN_PATH = '/preferred-language';
const MAX_PATH_LENGTH = 2048;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

export function safeReturnPath(path: unknown, fallback: string = DEFAULT_RETURN_PATH): string {
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) return fallback;
  // One leading slash, then a path segment: not "//", not "/\", not a scheme.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return fallback;
  if (path.includes('\\') || CONTROL_OR_SPACE.test(path)) return fallback;
  return path;
}
