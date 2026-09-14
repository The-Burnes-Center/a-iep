import './AIEPSpinner.css';

/**
 * The one loading indicator in the app.
 *
 * Before this there were four: react-bootstrap's `<Spinner>` at two sizes,
 * a hand-written `.spinner-border` span, react-spinners' `ClipLoader` at a
 * hardcoded cream, and `<Spinner>` with no accessible name at all. Half named
 * themselves "Loading..." in English on pages that were otherwise translated.
 *
 * The shape is taken from the A-IEP mark (`public/images/logo-v-white.svg`),
 * whose four letterforms are drawn from one module: a rounded square with a
 * corner radius of ~31% of its side, laid out two across and two down. This
 * draws that module four times in that grid and runs the highlight round it.
 * Four blocks read as the mark at 56px and still read as a spinner at 16px,
 * which a four-letter wordmark would not.
 *
 * Accessibility, both of which the CSS carries and AIEPSpinner.test.tsx pins:
 *  - `label` is the accessible name, inside `role="status"` so a screen reader
 *    announces the wait. Omit it only where something visible beside the
 *    spinner already says what is happening (a button reading "Saving..."),
 *    in which case the spinner is decoration and is hidden outright rather
 *    than announced twice.
 *  - `prefers-reduced-motion: reduce` stops the animation dead and leaves the
 *    four modules at full opacity. A parent who asked their OS for less motion
 *    gets a static mark, not a slower one.
 */

/** Top-left, top-right, bottom-right, bottom-left: the order the highlight travels. */
const CELLS = [
  { x: 0, y: 0 },
  { x: 54, y: 0 },
  { x: 54, y: 54 },
  { x: 0, y: 54 },
];

const CELL_SIZE = 46;
/** 30.4% of the side, the mark's own corner radius. */
const CELL_RADIUS = 14;

interface AIEPSpinnerProps {
  /**
   * Accessible name for the wait, translated. Leave it out only when a
   * visible label next to the spinner already carries it.
   */
  label?: string;
  /** sm sits inside a button, md inside a card, lg fills a page. */
  size?: 'sm' | 'md' | 'lg';
  /** Centres it in the viewport, for a route guard or the boot screen. */
  fullPage?: boolean;
  className?: string;
}

export default function AIEPSpinner({
  label,
  size = 'md',
  fullPage = false,
  className,
}: AIEPSpinnerProps) {
  const spinner = (
    <span
      className={['aiep-spinner', `aiep-spinner-${size}`, className]
        .filter(Boolean)
        .join(' ')}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg
        className="aiep-spinner-mark"
        viewBox="0 0 100 100"
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
        aria-hidden="true"
      >
        {CELLS.map((cell) => (
          <rect
            key={`${cell.x}-${cell.y}`}
            className="aiep-spinner-cell"
            x={cell.x}
            y={cell.y}
            width={CELL_SIZE}
            height={CELL_SIZE}
            rx={CELL_RADIUS}
            ry={CELL_RADIUS}
          />
        ))}
      </svg>
      {label ? <span className="visually-hidden">{label}</span> : null}
    </span>
  );

  if (!fullPage) return spinner;
  return <div className="aiep-spinner-page">{spinner}</div>;
}
