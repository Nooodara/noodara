import { describe, expect, it, vi } from 'vitest';
import { Notice } from './Notice.js';
import { renderUi, screen, userEvent, within } from './testing/render.js';

describe('Notice', () => {
  it('renders its message', () => {
    renderUi(<Notice message="Noodara trusted this server's host key on first connection." />);

    expect(
      screen.getByText("Noodara trusted this server's host key on first connection."),
    ).toBeInTheDocument();
  });

  it('renders a dismiss button that invokes onDismiss exactly once on click when supplied', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderUi(<Notice message="First-trust notice." onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders no dismiss button when onDismiss is absent', () => {
    const { container } = renderUi(<Notice message="First-trust notice." />);

    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });

  it('renders its children slot for mono command/fingerprint content', () => {
    renderUi(
      <Notice message="First-trust notice.">
        <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
      </Notice>,
    );

    expect(screen.getByText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).toBeInTheDocument();
  });

  it('never manages its own dismissed state -- the message stays visible across a re-render', () => {
    const { rerender, container } = renderUi(<Notice message="First-trust notice." onDismiss={vi.fn()} />);

    rerender(<Notice message="First-trust notice." onDismiss={vi.fn()} />);

    expect(within(container).getByText('First-trust notice.')).toBeInTheDocument();
  });

  it('never renders a data-tone="error" element -- the first-trust notice is deliberately neutral', () => {
    const { container } = renderUi(<Notice message="First-trust notice." onDismiss={vi.fn()} />);

    expect(container.querySelector('[data-tone="error"]')).toBeNull();
  });
});
