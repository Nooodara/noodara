// 29-01 (H1): real credential shapes that must never appear in the dataset. Canaries are
// NOODARA_CANARY_<hex>; anything that looks like a provider key or an SSH private key is a
// committed secret. Word boundaries matter: `disk-` contains `sk-`.
export const REAL_SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'ssh-private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'openssh-key-body', pattern: /\bb3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*/ },
]);

/** The names of the real-secret patterns `text` matches. */
export function findRealSecrets(text: string): string[] {
  return REAL_SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
