// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ENV_FALLBACK_MESSAGE =
  'Hardcoded env fallbacks are forbidden (PITFALLS.md #1). Validate in src/env.ts instead.';

// Matches `process.env.X ?? 'literal'` and `process.env.X || 'literal'` — RESEARCH Pitfall 1 /
// PITFALLS.md #1 (Dokploy CVE-2026-45631). Required env vars must be Zod-validated in src/env.ts,
// never given a silent string-literal fallback.
const envFallbackSelectors = [
  {
    selector:
      "LogicalExpression[operator='??'][left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name='process'][left.object.property.name='env'][right.type='Literal']",
    message: ENV_FALLBACK_MESSAGE,
  },
  {
    selector:
      "LogicalExpression[operator='||'][left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name='process'][left.object.property.name='env'][right.type='Literal']",
    message: ENV_FALLBACK_MESSAGE,
  },
];

const noDeepDomainImports = {
  patterns: [
    {
      group: ['**/packages/domain/src/*', '**/domain/src/**', '@noodara/domain/src/*'],
      message:
        'Deep imports into packages/domain/src are forbidden; import a package entrypoint (., ./server, ./security, ./validators, ./activity) instead.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.turbo/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': ['error', ...envFallbackSelectors],
      'no-restricted-imports': ['error', noDeepDomainImports],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-syntax': ['error', ...envFallbackSelectors],
      'no-restricted-imports': ['error', noDeepDomainImports],
    },
  },
);
