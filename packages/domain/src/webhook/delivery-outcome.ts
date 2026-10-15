// Closed vocabulary of recorded GitHub webhook delivery outcomes (16-05, OPEN_QUESTIONS #18). The
// `webhook_deliveries.outcome` column (16-06) and the deliveries UI (19-03) consume this list; a
// duplicate X-GitHub-Delivery creates no row, so it has no outcome here.

export const WEBHOOK_DELIVERY_OUTCOMES = Object.freeze([
  "deployed",
  "coalesced",
  "superseded",
  "already_deployed",
  "ping",
  "ignored_event",
  "ignored_tag",
  "ignored_ref",
  "ignored_branch",
  "ignored_deletion",
  "repository_mismatch",
  "invalid_payload",
  "invalid_sha",
  "project_archived",
  "source_not_git",
] as const);

export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

export function isWebhookDeliveryOutcome(
  value: unknown,
): value is WebhookDeliveryOutcome {
  return (WEBHOOK_DELIVERY_OUTCOMES as readonly unknown[]).includes(value);
}
