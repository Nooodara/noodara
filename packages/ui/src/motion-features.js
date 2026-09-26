// 08-12-PLAN.md Task 2 (D19, UI-06): the `domMax` feature bundle `Sheet.tsx`'s `LazyMotion`
// lazily imports. `domMax` is required, not the smaller feature bundle: that smaller bundle covers
// animations/variants/exit/tap/hover/focus gestures but excludes pan/drag entirely (research
// Architecture Patterns Pattern 1, Context7-verified against https://motion.dev/docs/react-reduce-
// bundle-size), and this Sheet needs `drag="x"` for its drag-to-dismiss gesture.
//
// This file exists as its own module (rather than importing `domMax` directly inside Sheet.tsx)
// so `LazyMotion`'s `features` prop can take the lazy-import function form
// (`() => import('./motion-features.js').then((res) => res.default)`) -- the whole point of
// `LazyMotion` is that this bundle is not in the initial page load, only fetched once a Sheet is
// actually about to render (T-08-33: keeps the drag physics bundle out of the initial payload).
import { domMax } from 'motion/react';

export default domMax;
