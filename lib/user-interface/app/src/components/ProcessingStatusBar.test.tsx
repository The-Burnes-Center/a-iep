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

describe('ProcessingStatusBar step count', () => {
  test('shows "Step N of 5" beside the name, and keeps the name as the bar\'s label', () => {
    render(
      <ProcessingStatusBar
        document={{ status: 'PROCESSING', current_step: 'cleanup_complete' }}
        stepLabel={STEP_LABEL}
      />,
    );

    const line = document.querySelector('.processing-status-step') as HTMLElement;
    expect(line.querySelector('.processing-status-step-count')).toHaveTextContent('Step 3 of 5');
    // The name alone still names the bar; the count is carried by valuetext.
    expect(screen.getByRole('progressbar', { name: STEP_LABEL })).toBeInTheDocument();
  });

  test.each([
    [undefined, 1],
    ['ocr_complete', 2],
    ['cleanup_complete', 3],
    ['analysis_complete', 4],
    ['translation_complete', 5],
  ])('after %s the bar reads "Step %i of 5, <step>"', (current_step, number) => {
    render(
      <ProcessingStatusBar
        document={{ status: 'PROCESSING', current_step }}
        stepLabel={STEP_LABEL}
      />,
    );

    expect(screen.getByTestId('processing-progress-bar')).toHaveAttribute(
      'aria-valuetext',
      `Step ${number} of 5, ${STEP_LABEL}`,
    );
    expect(screen.getByText(`Step ${number} of 5`)).toBeInTheDocument();
  });

  test('takes the wording from the templates it is given, word order included', () => {
    render(
      <ProcessingStatusBar
        document={{ status: 'PROCESSING', current_step: 'ocr_complete' }}
        stepLabel="Paso"
        stepOfTemplate="Paso {number} de {total}"
        valueTextTemplate="{step}: paso {number} de {total}"
      />,
    );

    expect(screen.getByText('Paso 2 de 5')).toBeInTheDocument();
    expect(screen.getByTestId('processing-progress-bar')).toHaveAttribute(
      'aria-valuetext',
      'Paso: paso 2 de 5',
    );
  });

  test('claims no number for a step it does not know, and keeps the bar honest', () => {
    const { container } = render(
      <ProcessingStatusBar
        document={{ status: 'PROCESSING', current_step: 'some_future_step' }}
        stepLabel={STEP_LABEL}
      />,
    );

    expect(container.querySelector('.processing-status-step-count')).toBeNull();
    const bar = screen.getByTestId('processing-progress-bar');
    expect(bar).not.toHaveAttribute('aria-valuetext');
    expect(bar).toHaveAttribute('aria-valuenow');
  });
});
