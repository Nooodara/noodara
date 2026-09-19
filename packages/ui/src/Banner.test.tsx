import { describe, expect, it, vi } from 'vitest';
import { Banner } from './Banner.js';
import { renderUi, screen, userEvent, within } from './testing/render.js';

describe('Banner', () => {
  it('renders the message prop verbatim, with nothing prefixed, appended or reformatted', () => {
    renderUi(<Banner message="Couldn't load servers." />);

    expect(screen.getByText("Couldn't load servers.")).toHaveTextContent("Couldn't load servers.");
  });

  it('renders an errorCode in a separate data-mono element, never concatenated into the message', () => {
    renderUi(<Banner message="Couldn't load servers." errorCode="INTERNAL_ERROR" />);

    const codeEl = screen.getByText('INTERNAL_ERROR');
    expect(codeEl).toHaveAttribute('data-mono', 'true');
    expect(screen.getByText("Couldn't load servers.")).not.toHaveTextContent('INTERNAL_ERROR');
  });

  it('renders no data-mono element when errorCode is absent', () => {
    const { container } = renderUi(<Banner message="Couldn't load servers." />);

    expect(container.querySelector('[data-mono]')).toBeNull();
  });

  it('renders its children slot alongside the message, so a caller can stack extra rows', () => {
    renderUi(
      <Banner message="Host key changed.">
        <p>Trusted: aa:bb:cc</p>
        <p>Observed: dd:ee:ff</p>
      </Banner>,
    );

    expect(screen.getByText('Trusted: aa:bb:cc')).toBeInTheDocument();
    expect(screen.getByText('Observed: dd:ee:ff')).toBeInTheDocument();
  });

  it('renders exactly one button when an action is supplied', () => {
    const { container } = renderUi(
      <Banner message="Couldn't load servers." action={{ label: 'Retry', onClick: vi.fn() }} />,
    );

    expect(within(container).getAllByRole('button')).toHaveLength(1);
    expect(within(container).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders zero buttons when no action is supplied', () => {
    const { container } = renderUi(<Banner message="Couldn't load servers." />);

    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });

  it('invokes the action onClick exactly once when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(<Banner message="Couldn't load servers." action={{ label: 'Retry', onClick }} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
