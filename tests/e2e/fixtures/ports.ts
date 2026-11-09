/** Test harness host ports only; unrelated to deployed application/container ports. */
export interface E2ePorts {
  readonly webPort: number;
  readonly apiPort: number;
  readonly webOrigin: string;
  readonly apiOrigin: string;
}

export function resolveE2ePorts(env: Readonly<Record<string, string | undefined>> = process.env): E2ePorts {
  const port = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    // Never echo input: a typo may contain a credential.
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 65535) {
      throw new Error(`${name} must be a decimal port in range 1..65535`);
    }
    return Number(raw);
  };
  const webPort = port('NOODARA_E2E_WEB_PORT', 3000);
  const apiPort = port('NOODARA_E2E_API_PORT', 3100);
  if (webPort === apiPort) throw new Error('NOODARA_E2E_WEB_PORT and NOODARA_E2E_API_PORT must be distinct');
  return { webPort, apiPort, webOrigin: `http://localhost:${String(webPort)}`, apiOrigin: `http://localhost:${String(apiPort)}` };
}
