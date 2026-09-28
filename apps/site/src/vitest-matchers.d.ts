// Type-only augmentation, no runtime code: pulls @testing-library/jest-dom's Vitest `Assertion`
// interface merge (toBeInTheDocument, toBeDisabled, toHaveValue, ...) into this package's own tsc
// program. Mirrors packages/ui/src/testing/vitest-matchers.d.ts -- the runtime matcher
// registration itself happens once, for real, in vitest.setup.dom.ts's
// `import '@testing-library/jest-dom/vitest'` -- that file lives outside apps/site's tsconfig
// `include` (repo root, not under src/), so its ambient module augmentation would otherwise never
// reach `tsc --noEmit` here.
/// <reference types="@testing-library/jest-dom/vitest" />
