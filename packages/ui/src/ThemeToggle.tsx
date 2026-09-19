import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from './Button.js';

// The single storage key this whole codebase ever reads/writes for the theme preference --
// exported (not re-declared) so ThemeToggle.test.tsx never repeats the literal string, keeping
// exactly one place this key is spelled out (this file's own acceptance criteria: `grep -rc
// "noodara-theme" packages/ui/src` is 1). apps/web/src/lib/theme-script.ts's first-paint
// bootstrap script reads the identical literal independently, by design -- that file runs before
// any JS bundle (this module included) is even parsed, so it cannot import from here.
export const STORAGE_KEY = 'noodara-theme';

type StoredTheme = 'light' | 'dark';
type Mode = StoredTheme | 'system';

// Never trusts a tampered/foreign stored value -- only the two literal strings this component
// itself ever writes are accepted back; anything else (missing key, or a stray value from a
// browser extension/older version) falls back to 'system' exactly like theme-script.ts's own
// bootstrap does for a missing key.
function readStoredTheme(): StoredTheme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function resolveSystemTheme(): StoredTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function nextMode(mode: Mode): Mode {
  if (mode === 'light') {
    return 'dark';
  }
  if (mode === 'dark') {
    return 'system';
  }
  return 'light';
}

const MODE_LABEL: Record<Mode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const MODE_ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const ICON_PROPS = { 'aria-hidden': true, size: 16, strokeWidth: 1.5 } as const;

export interface ThemeToggleProps {
  readonly 'data-testid'?: string;
}

// ThemeToggle (05-UI-SPEC.md Theme switching, Component Inventory) -- the only component in this
// codebase that writes localStorage's noodara-theme key or document.documentElement's data-theme
// attribute after the initial page load. Its only counterpart is apps/web's first-paint bootstrap
// script (apps/web/src/lib/theme-script.ts, THEME_BOOTSTRAP_SCRIPT), which reads that same
// key/attribute once, synchronously, before hydration, and never writes to either again -- this
// component owns every write from user interaction onward, cycling light -> dark -> system.
// `data-theme` only ever receives 'light' or 'dark' (never the literal 'system' string): the
// `applyTheme` helper's parameter type is `StoredTheme`, so a caller cannot pass 'system' through
// even by mistake, and every localStorage access is try/catch-guarded so a browser with storage
// disabled (private mode, a blocking extension, a full quota) never breaks the toggle.
export function ThemeToggle({ 'data-testid': testId }: ThemeToggleProps) {
  const [mode, setMode] = useState<Mode>(() => readStoredTheme() ?? 'system');

  useEffect(() => {
    const resolved: StoredTheme = mode === 'system' ? resolveSystemTheme() : mode;
    document.documentElement.setAttribute('data-theme', resolved);
  }, [mode]);

  const handleClick = () => {
    const next = nextMode(mode);
    try {
      if (next === 'system') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Storage disabled or full -- data-theme still updates via the effect above, since the
      // mode state change below does not depend on this write having succeeded.
    }
    setMode(next);
  };

  const Icon = MODE_ICON[mode];

  return (
    <Button
      variant="ghost"
      data-testid={testId}
      aria-label={`Theme: ${MODE_LABEL[mode]}`}
      onClick={handleClick}
    >
      <Icon {...ICON_PROPS} />
    </Button>
  );
}
