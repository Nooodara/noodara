// What a matching push does to a service (16-05, OPEN_QUESTIONS #18): a repeated delivery id is a
// duplicate; an idle service deploys the pushed SHA now unless it is already deployed; during an
// active deployment the push takes the single pending slot (latest wins, the previous pending
// delivery is superseded). When the active deployment ends, decidePendingTrigger runs or drops it.

import type { WebhookDeliveryOutcome } from "./delivery-outcome.js";

export interface IncomingDelivery {
  readonly deliveryId: string;
  readonly sha: string;
}

export interface PendingTrigger {
  readonly deliveryId: string;
  readonly sha: string;
}

export interface DeliveryDecisionInput {
  readonly incoming: IncomingDelivery;
  /** The stored delivery with the same X-GitHub-Delivery id, if any. */
  readonly existing: { readonly deploymentId: string | null } | null;
  /** The service's non-terminal deployment, if any; `sha` is null when it has no commit. */
  readonly active: {
    readonly deploymentId: string;
    readonly sha: string | null;
  } | null;
  readonly pending: PendingTrigger | null;
  /** Commit of the service's current successful deployment. */
  readonly deployedSha: string | null;
}

export type DeliveryDecision =
  | { readonly kind: "duplicate"; readonly deploymentId: string | null }
  | {
      readonly kind: "deploy";
      readonly outcome: Extract<WebhookDeliveryOutcome, "deployed">;
      readonly sha: string;
      readonly supersededDeliveryId: string | null;
    }
  | {
      readonly kind: "coalesce";
      readonly outcome: Extract<WebhookDeliveryOutcome, "coalesced">;
      readonly sha: string;
      readonly supersededDeliveryId: string | null;
    }
  | {
      readonly kind: "drop";
      readonly outcome: Extract<WebhookDeliveryOutcome, "already_deployed">;
      readonly supersededDeliveryId: string | null;
    };

export type PendingTriggerDecision =
  | { readonly kind: "none" }
  | { readonly kind: "run"; readonly deliveryId: string; readonly sha: string }
  | {
      readonly kind: "drop";
      readonly deliveryId: string;
      readonly outcome: Extract<WebhookDeliveryOutcome, "already_deployed">;
    };

export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const { incoming, existing, active, pending, deployedSha } = input;
  if (existing !== null)
    return { kind: "duplicate", deploymentId: existing.deploymentId };

  const supersededDeliveryId =
    pending !== null && pending.deliveryId !== incoming.deliveryId
      ? pending.deliveryId
      : null;

  if (active !== null) {
    return {
      kind: "coalesce",
      outcome: "coalesced",
      sha: incoming.sha,
      supersededDeliveryId,
    };
  }
  if (incoming.sha === deployedSha) {
    return { kind: "drop", outcome: "already_deployed", supersededDeliveryId };
  }
  return {
    kind: "deploy",
    outcome: "deployed",
    sha: incoming.sha,
    supersededDeliveryId,
  };
}

/** Called when the active deployment ends, with the commit now deployed. */
export function decidePendingTrigger(
  pending: PendingTrigger | null,
  deployedSha: string | null,
): PendingTriggerDecision {
  if (pending === null) return { kind: "none" };
  if (pending.sha === deployedSha) {
    return {
      kind: "drop",
      deliveryId: pending.deliveryId,
      outcome: "already_deployed",
    };
  }
  return { kind: "run", deliveryId: pending.deliveryId, sha: pending.sha };
}
