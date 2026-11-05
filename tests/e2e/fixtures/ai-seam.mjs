// 30-05: e2e-only preload for the API process (`node --import`), wired by fixtures/stack.ts next
// to dns-seam.mjs and never shipped in an image, compose file or the installer. While the replay
// provider (helpers/replay-provider.ts) runs it writes its `127.0.0.1:<port>` to
// $E2E_AI_REPLAY_FILE; every fetch to a pinned AI vendor host is then sent to that loopback
// address instead. The file is read on each call: without it (live mode, NOODARA_AI_EVAL_LIVE=1)
// every request goes to the real vendor unchanged. The provider's guarded fetch has already
// checked the vendor URL by the time it reaches this function.
import { readFileSync } from 'node:fs';

const file = process.env.E2E_AI_REPLAY_FILE;
const LOOPBACK_TARGET = /^127\.0\.0\.1:\d{1,5}$/;
const VENDOR_ORIGINS = new Set(['https://api.anthropic.com', 'https://api.openai.com']);

if (file !== undefined && file !== '') {
  const original = globalThis.fetch;

  const replayTarget = () => {
    try {
      const target = readFileSync(file, 'utf8').trim();
      return LOOPBACK_TARGET.test(target) ? target : null;
    } catch {
      return null;
    }
  };

  globalThis.fetch = function e2eAiReplayFetch(input, init) {
    const href = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    let url;
    try {
      url = new URL(href);
    } catch {
      return original(input, init);
    }
    if (!VENDOR_ORIGINS.has(url.origin)) return original(input, init);
    const target = replayTarget();
    if (target === null) return original(input, init);
    const rewritten = `http://${target}${url.pathname}${url.search}`;
    return input instanceof Request ? original(new Request(rewritten, input), init) : original(rewritten, init);
  };
}
