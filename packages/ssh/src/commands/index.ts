// Pure barrel over the four command modules. COMMAND_TEMPLATES/commandFor/escapeShellArg are
// deliberately declared in allowlist.ts, not here: vitest.config.ts's coverage config excludes
// `**/index.ts`, and this content must be measured.
export * from './discovery.js';
export * from './docker.js';
export * from './access.js';
export * from './allowlist.js';
