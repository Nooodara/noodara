// Type-only augmentation, no runtime code: pulls @testing-library/jest-dom's Vitest `Assertion`
// interface merge (toBeInTheDocument, toBeDisabled, toHaveValue, ...) into this package's own
// tsc program. The runtime matcher registration itself happens once, for real, in
// vitest.setup.dom.ts's `import '@testing-library/jest-dom/vitest'` -- that file lives outside
// packages/ui's tsconfig `include` (repo root, not under src/), so its ambient module
// augmentation would otherwise never reach `tsc --noEmit` here or eslint's `projectService`
// type-aware linting for *.test.tsx files under src/.
/// <reference types="@testing-library/jest-dom/vitest" />
