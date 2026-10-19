import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import ProcessingStatusBar from './ProcessingStatusBar';
import { processingProgressState } from '../pages/utils/processing-progress.mjs';

const STEP_LABEL = 'Writing your plain-language summary';
const DOCUMENT = { status: 'PROCESSING', progress: 40, current_step: 'summary_written' };

describe('ProcessingStatusBar progress semantics', () => {
  test('exposes a determinate progressbar named by the step line', () => {
    render(<ProcessingStatusBar document={DOCUMENT} stepLabel={STEP_LABEL} />);

    const bar = screen.getByRole('progressbar', { name: STEP_LABEL });

    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow');
    const value = Number(bar.getAttribute('aria-valuenow'));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });

  test('draws the eased value, and reports the confirmed milestone beside it', () => {
    render(<ProcessingStatusBar document={DOCUMENT} stepLabel={STEP_LABEL} />);

    const bar = screen.getByTestId('processing-progress-bar');

    // Mounted at the moment the milestone is first seen, so the bar has not
    // started easing yet: drawn value and confirmed value are the same.
    expect(bar).toHaveAttribute(
      'data-confirmed-percent',
      String(processingProgressState(DOCUMENT).confirmedPercent),
    );
    expect(bar.getAttribute('aria-valuenow')).toBe(bar.getAttribute('data-confirmed-percent'));
  });

  test('sits inside a track, and the fill is the element carrying the value', () => {
    const { container } = render(
      <ProcessingStatusBar document={DOCUMENT} stepLabel={STEP_LABEL} />,
    );

    const track = container.querySelector('.processing-status-bar');
    expect(track).toHaveClass('progress');
    expect(track?.querySelector('[role="progressbar"]')).toBe(
      screen.getByTestId('processing-progress-bar'),
    );
  });
});
