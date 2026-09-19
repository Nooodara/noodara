import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderUi, userEvent } from './render.js';

// This file proves the `dom` Vitest project + renderUi harness (05-06-PLAN.md Task 2) before
// either exists. RED: run before vitest.config.ts declares the `dom` project and before this
// file's sibling render.tsx is written -- see 05-06-SUMMARY.md for the exact failure observed.

describe('renderUi', () => {
  it('renders into jsdom and resolves a query by role', () => {
    const { getByRole } = renderUi(<button type="button">Go</button>);

    expect(getByRole('button', { name: 'Go' })).toBeDefined();
  });

  it('registers jest-dom matchers globally, without a per-file import', () => {
    const { getByRole } = renderUi(
      <>
        <button type="button">Go</button>
        <button type="button" disabled>
          Disabled
        </button>
      </>,
    );

    expect(getByRole('button', { name: 'Go' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Disabled' })).toBeDisabled();
  });

  it('drives a real click via userEvent, invoking the handler exactly once', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { getByRole } = renderUi(
      <button type="button" onClick={onClick}>
        Go
      </button>,
    );

    await user.click(getByRole('button', { name: 'Go' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('types into an input keystroke by keystroke via userEvent', async () => {
    const user = userEvent.setup();
    const { getByLabelText } = renderUi(
      <label>
        Name
        <input aria-label="Name" />
      </label>,
    );

    const input = getByLabelText('Name');
    await user.type(input, 'Pablo');

    expect(input).toHaveValue('Pablo');
  });

  it('re-renders a useState component after a click, proving one React instance', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button
          type="button"
          onClick={() => {
            setCount((c) => c + 1);
          }}
        >
          Count: {count}
        </button>
      );
    }

    const user = userEvent.setup();
    const { getByRole } = renderUi(<Counter />);
    const button = getByRole('button');

    expect(button).toHaveTextContent('Count: 0');
    await user.click(button);
    expect(button).toHaveTextContent('Count: 1');
  });

  it('starts each test with an empty DOM, proving cleanup runs between tests', () => {
    expect(document.body.innerHTML).toBe('');
  });
});
