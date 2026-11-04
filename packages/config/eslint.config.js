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

export const deepDomainImportPattern = {
  group: ['**/packages/domain/src/*', '**/domain/src/**', '@noodara/domain/src/*'],
  message:
    'Deep imports into packages/domain/src are forbidden; import a package entrypoint (., ./server, ./security, ./validators, ./activity) instead.',
};

// v0.5 (28-01, A3): AI provider SDKs live only in packages/ai/src/providers, which re-enables
// them in packages/ai/eslint.config.js. Everywhere else goes through @noodara/ai.
export const providerSdkImportPattern = {
  regex: '^(@anthropic-ai/|openai(/|$)|@aws-sdk/|@azure/openai(/|$))',
  message: 'AI provider SDKs may only be imported under packages/ai/src/providers; use @noodara/ai instead.',
};

const noDeepDomainImports = {
  patterns: [deepDomainImportPattern, providerSdkImportPattern],
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', '**/node_modules/**'],
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
      // A leading underscore is a deliberate, explicit "intentionally unused" marker — most
      // commonly an inert extension-point stub whose parameter list must match a future real
      // implementation's signature (e.g. a hook a later plan fills in). This does not relax
      // detection of accidentally-unused identifiers, which never start with `_`.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
