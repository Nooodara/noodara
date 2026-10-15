import { describe, expect, it } from "vitest";
import { selectRollbackTarget, type RollbackCandidate } from "./index.js";

const rc = (image: string) => ({
  version: 1, imageRef: image, internalPort: 3000, publishedPort: 20001,
  healthcheck: { type: "container", probeTimeoutS: 5, intervalS: 1, retries: 5, startPeriodS: 0 },
});
const c = (id: string, createdAt: number, over: Partial<RollbackCandidate> = {}): RollbackCandidate => ({
  id, serviceId: "svc", status: "SUCCESS", createdAt, imageRef: `img${id}`, runtimeConfig: rc(`img${id}`), ...over,
});
const ctx = (deployments: RollbackCandidate[], currentId = "3") => ({ serviceId: "svc", currentDeploymentId: currentId, deployments });
const retained = ["img1", "img2", "img3"];

describe("selectRollbackTarget", () => {
  it("returns the latest SUCCESS deployment other than the current one", () => {
    const r = selectRollbackTarget(ctx([c("1", 1), c("2", 2), c("3", 3), c("4", 4, { status: "FAILED" })]), retained);
    expect(r.ok && r.target.id).toBe("2");
  });
  it("skips candidates without a parseable runtime_config or retained image", () => {
    const h = [c("1", 1), c("2", 2, { runtimeConfig: null }), c("5", 5, { runtimeConfig: { version: 9 } }), c("6", 6, { imageRef: "gone", runtimeConfig: rc("gone") }), c("3", 3)];
    const r = selectRollbackTarget(ctx(h), retained);
    expect(r.ok && r.target.id).toBe("1");
  });
  it("names reasons for empty and only-current history", () => {
    expect(selectRollbackTarget(ctx([]), retained)).toEqual({ ok: false, reason: "none" });
    expect(selectRollbackTarget(ctx([c("3", 3)]), retained)).toEqual({ ok: false, reason: "none" });
  });
  it("reports image_pruned when every known-good candidate lost its image", () => {
    expect(selectRollbackTarget(ctx([c("1", 1), c("3", 3)]), [])).toEqual({ ok: false, reason: "image_pruned" });
  });
  it("never returns non-SUCCESS deployments", () => {
    const h = [c("1", 1, { status: "FAILED" }), c("2", 2, { status: "ROLLED_BACK" }), c("3", 3)];
    expect(selectRollbackTarget(ctx(h), retained)).toEqual({ ok: false, reason: "none" });
  });
  it("ignores other services' deployments when picking automatically", () => {
    const h = [c("1", 1, { serviceId: "other" }), c("3", 3)];
    expect(selectRollbackTarget(ctx(h), retained)).toEqual({ ok: false, reason: "none" });
  });
  describe("explicit target", () => {
    it("accepts a known-good retained one", () => {
      const r = selectRollbackTarget(ctx([c("1", 1), c("2", 2), c("3", 3)]), retained, "1");
      expect(r.ok && r.target.id).toBe("1");
    });
    it.each([
      ["3", "same_as_current"],
      ["9", "none"],
      ["7", "other_service"],
      ["8", "not_known_good"],
      ["4", "not_known_good"],
      ["5", "image_pruned"],
    ])("target %s -> %s", (id, reason) => {
      const h = [c("1", 1), c("3", 3), c("4", 4, { runtimeConfig: null }), c("5", 5, { imageRef: "gone" , runtimeConfig: rc("gone") }), c("7", 7, { serviceId: "other" }), c("8", 8, { status: "FAILED" })];
      expect(selectRollbackTarget(ctx(h), retained, id)).toEqual({ ok: false, reason });
    });
  });
});
