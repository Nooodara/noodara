// Shared committed-evidence hygiene rules (36-02 H5, reused by 35-03 A6). Evidence written from
// real runs on contributor machines or CI must never carry home paths, IP addresses, host or user
// names, token-shaped strings or full UUIDs. The verdict depends only on the committed text, never
// on the machine running the suite (no os.hostname()/os.userInfo() literals; see MachineIdentities).
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const HYGIENE_RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'home path', pattern: /[\\/](?:home|Users)[\\/][A-Za-z0-9._-]+/ },
  { name: 'Windows user path', pattern: /\b[A-Za-z]:[\\/]+Users[\\/]/i },
  { name: 'IPv4 address', pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/ },
  { name: 'IPv6 address', pattern: /(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}(?::[0-9a-f]{1,4}){1,7}(?![\w:])|(?<![\w:])::1(?![\w:])/i },
  { name: 'full UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'API key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./ },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'credential assignment', pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"`]{8,}/i },
  { name: 'user@host prompt', pattern: /\b[a-z_][a-z0-9_.-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,62}:[~/]/ },
  { name: 'Windows default hostname', pattern: /\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{7,8}\b/ },
];

/**
 * Literal machine identities (a hostname or user name) are optional, injected inputs; they are
 * never read from the machine running the suite, so the verdict on a committed report does not
 * depend on who runs `pnpm test`. An injected value is only matched when it is distinctive
 * (6+ characters with a digit or a hyphen, e.g. `build-box-07`): ordinary words such as `ubuntu`,
 * `test` or `noodara` legitimately appear in a run report. Host and user names are otherwise
 * caught structurally: home paths, `user@host:` prompts and Windows default hostnames.
 */
export interface MachineIdentities { readonly hostname?: string; readonly username?: string }

function identityRule(name: string, value: string | undefined): { name: string; pattern: RegExp } | undefined {
  const literal = (value ?? '').trim().toLowerCase();
  if (literal.length < 6 || !/[0-9-]/.test(literal)) return undefined;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { name, pattern: new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i') };
}

export function findLeaks(text: string, identities: MachineIdentities = {}): string[] {
  const rules = [...HYGIENE_RULES];
  for (const rule of [
    identityRule('run machine hostname', identities.hostname),
    identityRule('run machine user name', identities.username),
  ]) if (rule !== undefined) rules.push(rule);
  const leaks: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const rule of rules) if (rule.pattern.test(line)) leaks.push(`line ${String(index + 1)}: ${rule.name}`);
  });
  return leaks;
}

export function docFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? docFiles(full) : [full];
  });
}
