import { describe, expect, it } from "vitest";
import {
  WEBHOOK_DELIVERY_OUTCOMES,
  type DeliveryDecisionInput,
  decideDelivery,
  decidePendingTrigger,
  isWebhookDeliveryOutcome,
} from "./index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const input = (
  over: Partial<DeliveryDecisionInput> = {},
): DeliveryDecisionInput => ({
  incoming: { deliveryId: "d-new", sha: B },
  existing: null,
  active: null,
  pending: null,
  deployedSha: A,
  ...over,
});

describe("WEBHOOK_DELIVERY_OUTCOMES", () => {
  it("is a frozen closed vocabulary without duplicates", () => {
    expect(Object.isFrozen(WEBHOOK_DELIVERY_OUTCOMES)).toBe(true);
    expect(new Set(WEBHOOK_DELIVERY_OUTCOMES).size).toBe(
      WEBHOOK_DELIVERY_OUTCOMES.length,
    );
    expect(WEBHOOK_DELIVERY_OUTCOMES).toEqual([
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
    ]);
  });

  it("guards unknown values", () => {
    expect(isWebhookDeliveryOutcome("coalesced")).toBe(true);
    expect(isWebhookDeliveryOutcome("duplicate")).toBe(false);
    expect(isWebhookDeliveryOutcome(1)).toBe(false);
  });
});

describe("decideDelivery", () => {
  it.each<
    [string, Partial<DeliveryDecisionInput>, ReturnType<typeof decideDelivery>]
  >([
    [
      "duplicate delivery id returns the original deployment and records nothing",
      {
        existing: { deploymentId: "dep-1" },
        active: { deploymentId: "dep-2", sha: C },
      },
      { kind: "duplicate", deploymentId: "dep-1" },
    ],
    [
      "duplicate of a delivery that created no deployment",
      { existing: { deploymentId: null } },
      { kind: "duplicate", deploymentId: null },
    ],
    [
      "idle service deploys now",
      {},
      {
        kind: "deploy",
        outcome: "deployed",
        sha: B,
        supersededDeliveryId: null,
      },
    ],
    [
      "idle service with no deployment yet deploys now",
      { deployedSha: null },
      {
        kind: "deploy",
        outcome: "deployed",
        sha: B,
        supersededDeliveryId: null,
      },
    ],
    [
      "idle service with a stale pending deploys now and supersedes it",
      { pending: { deliveryId: "d-old", sha: C } },
      {
        kind: "deploy",
        outcome: "deployed",
        sha: B,
        supersededDeliveryId: "d-old",
      },
    ],
    [
      "idle service already on the pushed SHA drops it",
      { incoming: { deliveryId: "d-new", sha: A } },
      { kind: "drop", outcome: "already_deployed", supersededDeliveryId: null },
    ],
    [
      "idle drop still supersedes a stale pending",
      {
        incoming: { deliveryId: "d-new", sha: A },
        pending: { deliveryId: "d-old", sha: C },
      },
      {
        kind: "drop",
        outcome: "already_deployed",
        supersededDeliveryId: "d-old",
      },
    ],
    [
      "active deployment coalesces into the pending slot",
      { active: { deploymentId: "dep-2", sha: C } },
      {
        kind: "coalesce",
        outcome: "coalesced",
        sha: B,
        supersededDeliveryId: null,
      },
    ],
    [
      "active deployment replaces the previous pending, which is superseded",
      {
        active: { deploymentId: "dep-2", sha: C },
        pending: { deliveryId: "d-old", sha: C },
      },
      {
        kind: "coalesce",
        outcome: "coalesced",
        sha: B,
        supersededDeliveryId: "d-old",
      },
    ],
    [
      "active deployment with a pending of the same SHA: the latest delivery still wins",
      {
        active: { deploymentId: "dep-2", sha: C },
        pending: { deliveryId: "d-old", sha: B },
      },
      {
        kind: "coalesce",
        outcome: "coalesced",
        sha: B,
        supersededDeliveryId: "d-old",
      },
    ],
    [
      "active deployment of an unknown SHA (image or rollback) still coalesces",
      {
        active: { deploymentId: "dep-2", sha: null },
        incoming: { deliveryId: "d-new", sha: A },
      },
      {
        kind: "coalesce",
        outcome: "coalesced",
        sha: A,
        supersededDeliveryId: null,
      },
    ],
  ])("%s", (_name, over, expected) => {
    expect(decideDelivery(input(over))).toEqual(expected);
  });

  it("never supersedes the incoming delivery itself", () => {
    const decision = decideDelivery(
      input({
        active: { deploymentId: "dep-2", sha: C },
        pending: { deliveryId: "d-new", sha: B },
      }),
    );
    expect(decision).toEqual({
      kind: "coalesce",
      outcome: "coalesced",
      sha: B,
      supersededDeliveryId: null,
    });
  });
});

describe("decidePendingTrigger", () => {
  it.each<
    [
      string,
      Parameters<typeof decidePendingTrigger>,
      ReturnType<typeof decidePendingTrigger>,
    ]
  >([
    ["no pending trigger", [null, A], { kind: "none" }],
    [
      "pending SHA differs from the deployed one: run it",
      [{ deliveryId: "d1", sha: B }, A],
      { kind: "run", deliveryId: "d1", sha: B },
    ],
    [
      "nothing deployed yet: run it",
      [{ deliveryId: "d1", sha: B }, null],
      { kind: "run", deliveryId: "d1", sha: B },
    ],
    [
      "pending SHA equals the deployed SHA: drop it",
      [{ deliveryId: "d1", sha: A }, A],
      { kind: "drop", deliveryId: "d1", outcome: "already_deployed" },
    ],
  ])("%s", (_name, args, expected) => {
    expect(decidePendingTrigger(...args)).toEqual(expected);
  });
});
