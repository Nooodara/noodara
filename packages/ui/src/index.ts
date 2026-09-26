// Single barrel export for @noodara/ui (the Noodara design system).
//
// Plan 05-22 adds the first components (Button, StatusPill) and the two pure helpers (`cn`, the
// tone map) they rest on. Later plans append further component exports here as they land: 05-23,
// 05-24, 05-25 (see 05-06-PLAN.md's must_haves.artifacts and each of those plans' own frontmatter
// for the exact component -> plan assignment). Keep the export list alphabetical as it grows, so
// appends stay reviewable in diffs.
//
// Never export anything from the `src/testing` subdirectory here -- that surface is reachable
// only through the explicit `@noodara/ui/testing` subpath (see the render harness module under
// `src/testing/`), is excluded from coverage, and Plan 05-21's `check:ui-safety` gate fails if
// any non-test file imports it.
export { AccountMenu, type AccountMenuLinkProps, type AccountMenuProps } from './AccountMenu.js';
export { Banner, type BannerAction, type BannerProps } from './Banner.js';
export { Button, type ButtonProps, type ButtonVariant } from './Button.js';
export { cn } from './cn.js';
export { ConfirmDialog, type ConfirmDialogProps, DestructiveConfirmDialog, type DestructiveConfirmDialogProps } from './Dialog.js';
export { CopyButton, type CopyButtonProps } from './CopyButton.js';
export { Disclosure, type DisclosureProps } from './Disclosure.js';
export { discoveryCheckTone, serverStatusTone, STATUS_WORDS } from './tone.js';
export type { Tone } from './tone.js';
export { EmptyState, type EmptyStateAction, type EmptyStateProps } from './EmptyState.js';
export { Field, type FieldControlProps, type FieldProps } from './Field.js';
export { FileButton, type FileButtonProps } from './FileButton.js';
export { Fingerprint, type FingerprintProps } from './Fingerprint.js';
export {
  formatDiskUsage,
  formatIso,
  formatMb,
  formatRelativeTime,
  formatUptime,
  PLACEHOLDER,
  type DiskUsage,
} from './format.js';
export { Input, type InputProps } from './Input.js';
export { InsetGroup, type InsetGroupProps } from './InsetGroup.js';
export { isConfirmationMatch } from './confirm-match.js';
export { LabelValue, type LabelValueProps } from './LabelValue.js';
export { ListRow, type ListRowProps } from './ListRow.js';
export { NavTree, type NavTreeItem, type NavTreeProps } from './NavTree.js';
export { Notice, type NoticeProps } from './Notice.js';
export { RelativeTime, type RelativeTimeProps } from './RelativeTime.js';
export { RowMenu, type RowMenuItem, type RowMenuProps } from './RowMenu.js';
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from './SegmentedControl.js';
export { Sheet, type SheetProps } from './Sheet.js';
export { Skeleton, type SkeletonProps, SkeletonRow, type SkeletonRowProps, SkeletonText, type SkeletonTextProps } from './Skeleton.js';
export { StatTile, type StatTileProps } from './StatTile.js';
export { StatusPill, type StatusPillProps } from './StatusPill.js';
export { Textarea, type TextareaProps } from './Textarea.js';
export { ThemeToggle, type ThemeToggleProps } from './ThemeToggle.js';
export { Tooltip, TooltipProvider, type TooltipProps } from './Tooltip.js';

// Brand (07-03-PLAN.md Task 3): the three lockups D-04 defines, plus the concept metadata a
// caller needs to name or pick one. Kept as its own block at the end rather than merged into the
// alphabetical list above, so the brand surface reads as one unit.
//
// Deliberately NOT exported here (named descriptively rather than by filename, so this plan's own
// barrel grep stays exact): the static export module, the glyph builders, and the three per-concept
// constructions. This barrel is what `apps/web` sees, and none of those belong in a browser
// bundle -- the static export path pulls in `react-dom/server` and is consumed by build-time Node
// scripts (07-06) through relative paths, while the letter and concept builders are geometry
// internals reached through `monogramParts`/`wordmarkParts`.
export { CONCEPT_IDS, CONCEPT_META, DEFAULT_CONCEPT, type ConceptId } from './brand/geometry.js';
export { Lockup, type LockupProps } from './brand/Lockup.js';
export { Logo, type LogoProps } from './brand/Logo.js';
export { Wordmark, type WordmarkProps } from './brand/Wordmark.js';
