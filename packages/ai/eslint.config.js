// @ts-check
import shared, { deepDomainImportPattern } from '@noodara/config/eslint.config.js';

// 28-01 (A3): the shared config bans provider SDK imports everywhere; only the provider
// implementations may import them.
export default [
  ...shared,
  {
    files: ['src/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [deepDomainImportPattern] }],
    },
  },
];
