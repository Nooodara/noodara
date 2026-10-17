import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableWebhook,
  enableWebhook,
  getWebhook,
  listWebhookDeliveries,
  rotateWebhook,
  safePayloadUrl,
} from "./webhook-api";

const P = "11111111-1111-4111-8111-111111111111";
const S = "44444444-4444-4444-8444-444444444444";
const HOOK = "h".repeat(32);

function mockFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook-api", () => {
  it("calls the webhook routes with the right methods and paths", async () => {
    const fn = mockFetch({ enabled: false, payloadUrl: null });
    await getWebhook(P, S);
    await enableWebhook(P, S);
    await rotateWebhook(P, S);
    await disableWebhook(P, S);
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method ?? "?"} ${url}`)).toEqual([
      `GET /api/projects/${P}/services/${S}/webhook`,
      `POST /api/projects/${P}/services/${S}/webhook`,
      `POST /api/projects/${P}/services/${S}/webhook/rotate`,
      `DELETE /api/projects/${P}/services/${S}/webhook`,
    ]);
  });

  it("builds the deliveries query and refuses unsafe ids without a request", async () => {
    const fn = mockFetch({ deliveries: [], nextCursor: null });
    await listWebhookDeliveries(P, S, { limit: 20, cursor: "abc_-" });
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe(
      `/api/projects/${P}/services/${S}/webhook/deliveries?limit=20&cursor=abc_-`,
    );
    fn.mockClear();
    const result = await getWebhook("../x", S);
    expect(result.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts only a payload URL with a public origin and a well-formed hook id", () => {
    expect(safePayloadUrl(`https://n.example.com/webhooks/github/${HOOK}`)).toBe(
      `https://n.example.com/webhooks/github/${HOOK}`,
    );
    expect(safePayloadUrl(null)).toBeNull();
    expect(safePayloadUrl("javascript:alert(1)")).toBeNull();
    expect(safePayloadUrl(`https://u:p@n.example.com/webhooks/github/${HOOK}`)).toBeNull();
    expect(safePayloadUrl("https://n.example.com/webhooks/github/short")).toBeNull();
    expect(safePayloadUrl(`https://n.example.com/other/${HOOK}`)).toBeNull();
    expect(safePayloadUrl(`https://n.example.com/webhooks/github/${HOOK}?x=1`)).toBeNull();
  });
});
