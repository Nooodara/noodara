import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import { AskInspector, isAskOpen, withoutAsk } from './ask-inspector';

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/servers',
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
}));
vi.mock('../../../components/ai/AiChat', () => ({
  AiChat: () => <p data-testid="stub-chat">chat</p>,
}));

afterEach(() => {
  nav.search = '';
  vi.clearAllMocks();
});

describe('ask inspector', () => {
  it('opens only for ask=1', () => {
    expect(isAskOpen(new URLSearchParams('ask=1'))).toBe(true);
    expect(isAskOpen(new URLSearchParams('ask=true'))).toBe(false);
    expect(isAskOpen(new URLSearchParams(''))).toBe(false);
  });

  it('drops only the ask parameter on close', () => {
    expect(withoutAsk('/servers', new URLSearchParams('ask=1'))).toBe('/servers');
    expect(withoutAsk('/logs', new URLSearchParams('ask=1&level=error'))).toBe('/logs?level=error');
  });

  it('renders nothing without ask=1', () => {
    const { container } = renderUi(<AskInspector />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the chat in the inspector and closes it', () => {
    nav.search = 'ask=1&tab=metrics';
    renderUi(<AskInspector />);
    expect(screen.getByRole('heading', { name: 'Ask Noodara' })).toBeTruthy();
    expect(screen.getByTestId('stub-chat')).toBeTruthy();
    fireEvent.click(screen.getByTestId('inspector-close'));
    expect(nav.replace).toHaveBeenCalledWith('/servers?tab=metrics', { scroll: false });
  });
});
