// Fixed, static discovery command templates (SEC-04). No argument, no interpolation, ever — see
// allowlist.test.ts's exactness and no-`${`/backtick/`$(` guards.
// Source: 02-RESEARCH.md "Discovery command templates (fixed, static, no interpolation)".
export const DISCOVERY_COMMANDS = {
  'discovery.hostname': 'hostname',
  'discovery.os_release': 'cat /etc/os-release',
  'discovery.arch': 'uname -m',
  'discovery.cpu': 'nproc',
  'discovery.memory': 'cat /proc/meminfo',
  'discovery.disk': 'df -P -k /',
  'discovery.uptime': 'cat /proc/uptime',
} as const;
