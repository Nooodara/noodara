import { describe, expect, it } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import { AuthCard } from './AuthCard';

// 07-07: the brand mount point on the two unauthenticated screens (BRAND-02, D-04). `/setup` and
// `/login` render outside the authenticated shell, so this card is the entire page chrome -- and
// the horizontal lockup above the heading is the only place the product names itself there. It is
// painted with `currentColor` (D-09), so one SVG serves both themes with no theme branch and no
// second asset.

/** True when `first` comes before `second` in document order. */
function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('AuthCard brand slot', () => {
  it('renders the lockup as an svg painted with currentColor', () => {
    renderUi(
      <AuthCard title="Sign in">
        <p>form</p>
      </AuthCard>,
    );

    const lockup = screen.getByTestId('brand-lockup');
    expect(lockup.tagName.toLowerCase()).toBe('svg');
    expect(lockup.getAttribute('fill')).toBe('currentColor');
    expect(lockup.getAttribute('stroke')).toBeNull();
  });

  it('names the lockup "Noodara" as an image', () => {
    renderUi(
      <AuthCard title="Sign in">
        <p>form</p>
      </AuthCard>,
    );

    expect(screen.getByRole('img', { name: 'Noodara' })).toBe(screen.getByTestId('brand-lockup'));
  });

  it('places the lockup before the heading, inside the same card element', () => {
    renderUi(
      <AuthCard title="Sign in">
        <p>form</p>
      </AuthCard>,
    );

    const lockup = screen.getByTestId('brand-lockup');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(precedes(lockup, heading)).toBe(true);

    const card = heading.parentElement;
    expect(card).not.toBeNull();
    expect(card?.contains(lockup)).toBe(true);
  });

  it('still renders the title as the h1 and the children below it', () => {
    renderUi(
      <AuthCard title="Create admin account">
        <p>form fields</p>
      </AuthCard>,
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Create admin account');
    const children = screen.getByText('form fields');
    expect(precedes(heading, children)).toBe(true);
  });

  it('never paints the mark in a colour of its own', () => {
    renderUi(
      <AuthCard title="Sign in">
        <p>form</p>
      </AuthCard>,
    );

    const lockup = screen.getByTestId('brand-lockup');
    for (const path of lockup.querySelectorAll('path')) {
      expect(path.getAttribute('fill')).toBeNull();
    }
  });
});
