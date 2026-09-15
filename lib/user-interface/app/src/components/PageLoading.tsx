import AIEPSpinner from './AIEPSpinner';

interface PageLoadingProps {
  /**
   * The sentence a parent reads while they wait, translated and visible.
   *
   * When present it is also the announcement: the mark beside it becomes
   * decoration. Leave it out for a route guard, where there is no page yet to
   * describe and `label` names the wait instead.
   */
  message?: string;
  /**
   * Accessible name for the wait when there is no visible `message`.
   * Translated, and required in that case: a spinner with no name is a
   * silent wait for anyone using a screen reader.
   */
  label?: string;
}

/**
 * The one page-level loading state: a screen that has nothing on it yet.
 *
 * df46e8e unified the loading *indicator* into AIEPSpinner and left its
 * *placement* decided per screen, so sixteen screens hand-rolled a wrapper
 * and no two agreed. All five shapes centred horizontally and none centred
 * vertically, which is why the mark sat near the top:
 *
 *   <Container className="… mt-4 mb-5"><div className="text-center my-5">   x8
 *   <Container className="text-center">                                     x4
 *   <Container className="text-center profile-form-container">              x1
 *   <Container className="mt-4 text-center">                                x1
 *   <Container className="text-center mt-5">                                x2
 *
 * This fills the space AppShell already gives `<main>` and centres in it, so
 * the mark lands in the middle of the gap between the nav bar and the footer
 * rather than a fixed distance below the bar. Measured on a 375x812 phone:
 * 39% of the viewport before, 51% after.
 *
 * Genuinely inline waits are not this and keep their own markup: a spinner
 * inside a button, or the one in CurrentIEPDocument that replaces a single
 * row of a card while the rest of the screen stays put.
 */
export default function PageLoading({ message, label }: PageLoadingProps) {
  return (
    <div className="aiep-spinner-page aiep-page-loading">
      {/* No `label` when a visible message follows: the message is the
          announcement, and naming both said it twice. */}
      <AIEPSpinner size="lg" label={message ? undefined : label} />
      {message ? (
        <p className="aiep-page-loading__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
