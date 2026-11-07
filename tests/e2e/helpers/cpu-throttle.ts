// 31-08: CI runners are slower than a dev laptop, so data that lands "before the test looks" locally
// can land mid-test there. NOODARA_E2E_CPU_THROTTLE=<rate> (Chromium DevTools CPU throttling, e.g.
// 4 = four times slower) reproduces that locally. Unset, nothing changes.
import type { Page } from '@playwright/test';

/** The throttling rate from NOODARA_E2E_CPU_THROTTLE, or null when unset. */
export function cpuThrottleRate(raw: string | undefined = process.env['NOODARA_E2E_CPU_THROTTLE']): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 1) {
    throw new Error(`NOODARA_E2E_CPU_THROTTLE must be a number >= 1, got "${raw}"`);
  }
  return rate;
}

/** Applies NOODARA_E2E_CPU_THROTTLE to the page (Chromium only); a no-op when unset. */
export async function throttleCpuFromEnv(page: Page): Promise<void> {
  const rate = cpuThrottleRate();
  if (rate === null || rate === 1) return;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}
