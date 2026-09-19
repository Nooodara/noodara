import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Setup file for the `dom` Vitest project (05-06-PLAN.md Task 2) only. Two responsibilities,
// nothing else: register jest-dom's matcher set globally (toBeInTheDocument, toBeDisabled, ...)
// so no component test imports it per-file, and run Testing Library's cleanup() after every
// test so a mounted tree never leaks into the next test's empty-DOM assumption. No global
// mocks, no fetch stubs -- those belong in an individual test file, not here.
afterEach(() => {
  cleanup();
});
