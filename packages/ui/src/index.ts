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
export { isConfirmationMatch } from './confirm-match.js';
export { LabelValue, type LabelValueProps } from './LabelValue.js';
export { ListRow, type ListRowProps } from './ListRow.js';
export { Notice, type NoticeProps } from './Notice.js';
export { RelativeTime, type RelativeTimeProps } from './RelativeTime.js';
export { RowMenu, type RowMenuItem, type RowMenuProps } from './RowMenu.js';
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from './SegmentedControl.js';
export { Sheet, type SheetProps } from './Sheet.js';
export { Skeleton, type SkeletonProps, SkeletonRow, type SkeletonRowProps, SkeletonText, type SkeletonTextProps } from './Skeleton.js';
export { StatTile, type StatTileProps } from './StatTile.js';
export { StatusPill, type StatusPillProps } from './StatusPill.js';
export { Textarea, type TextareaProps } from './Textarea.js';
export { Tooltip, TooltipProvider, type TooltipProps } from './Tooltip.js';
