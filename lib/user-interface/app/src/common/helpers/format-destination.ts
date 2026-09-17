/**
 * A sign-in destination, formatted for a parent to read back.
 *
 * The one job this string has on the code screen is letting a parent check,
 * at a glance, that the number they typed is the number the code went to —
 * and "+18572212618" is exactly the shape in which a transposed pair hides.
 *
 * The two code screens hold the number differently: PasswordlessAuthForm has
 * the E.164 it sent to the API ("+18572212618"), CustomLogin has what its own
 * input formatted as the parent typed ("+1 (857) 221-2618"). Both normalize
 * to one grouping here, so the same number reads the same way whichever form
 * a deployment renders.
 *
 * Only NANP numbers are regrouped — a leading "+1" and ten more digits —
 * because three-three-four is their grouping and imposing it elsewhere would
 * invent one the reader does not use. Email addresses, numbers from any other
 * country, and half-typed input are returned untouched, which is also the
 * safe answer for anything unexpected.
 */
export const formatDestination = (destination: string): string => {
  if (!destination.startsWith('+1')) return destination;
  const digits = destination.replace(/\D/g, '');
  if (!/^1\d{10}$/.test(digits)) return destination;
  return `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
};
