/**
 * Where the sign-in form is, in one place.
 *
 * There used to be two of them: the card in the landing page's hero
 * (HeroSection.tsx) and a whole page at /login rendering a second
 * <CustomLogin/> in its own layout. /login now redirects to the card
 * (LoginRedirect.tsx), so this is the one target every "sign in" / "Upload An
 * IEP" link points at.
 *
 * The hash is load-bearing, not decoration. ScrollToTop deliberately leaves a
 * location with a hash alone (see its docblock), which is what lets the
 * arrival scroll to the card instead of being yanked back to the top of the
 * marketing page, and HeroSection keys its scroll-and-focus off this exact
 * value. A link to a bare '/' drops the parent several screens above the form.
 */
export const SIGN_IN_CARD_ID = 'sign-in';
export const SIGN_IN_HASH = `#${SIGN_IN_CARD_ID}`;
export const SIGN_IN_ROUTE = `/${SIGN_IN_HASH}`;
