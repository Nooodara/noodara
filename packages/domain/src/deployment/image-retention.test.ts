import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_RETENTION, imageRetention, type RetentionDeployment } from "./index.js";

const d = (id: string, status: RetentionDeployment["status"], imageRef: string | null, createdAt: number): RetentionDeployment => ({
  id, status, imageRef, createdAt,
});

describe("imageRetention", () => {
  const history = [
    d("1", "SUCCESS", "img1", 1),
    d("2", "SUCCESS", "img2", 2),
    d("3", "FAILED", "img3", 3),
    d("4", "SUCCESS", "img4", 4),
    d("5", "SUCCESS", "img5", 5),
    d("6", "SUCCESS", "img6", 6),
  ];
  it("defaults to 3 previous known-good plus the running image", () => {
    expect(DEFAULT_IMAGE_RETENTION).toBe(3);
    const r = imageRetention(history, "img6");
    expect(r.keep).toEqual(["img6", "img5", "img4", "img2"]);
    expect([...r.delete].sort()).toEqual(["img1", "img3"]);
  });
  it("never deletes the running image even when it is old", () => {
    const r = imageRetention(history, "img1", 1);
    expect(r.keep).toContain("img1");
    expect(r.delete).not.toContain("img1");
    expect(r.keep).toEqual(["img1", "img6"]);
  });
  it("never deletes the image of a non-terminal deployment", () => {
    const h = [...history, d("7", "BUILDING", "img7", 7), d("8", "ROLLING_BACK", "img1", 8)];
    const r = imageRetention(h, "img6", 1);
    expect(r.delete).not.toContain("img7");
    expect(r.delete).not.toContain("img1");
    expect(r.keep).toEqual(expect.arrayContaining(["img6", "img7", "img1"]));
  });
  it("clamps N to 1-10 and falls back to the default for invalid N", () => {
    const many = Array.from({ length: 15 }, (_, i) => d(String(i), "SUCCESS", `i${String(i)}`, i));
    expect(imageRetention(many, "i14", 0).keep).toHaveLength(2);
    expect(imageRetention(many, "i14", 99).keep).toHaveLength(11);
    expect(imageRetention(many, "i14", Number.NaN).keep).toHaveLength(4);
    expect(imageRetention(many, "i14", 2.7).keep).toHaveLength(4);
  });
  it("skips null images, dedupes refs, and handles a null running image", () => {
    const h = [d("1", "SUCCESS", null, 1), d("2", "FAILED", null, 2), d("3", "SUCCESS", "a", 3), d("4", "SUCCESS", "a", 4)];
    const r = imageRetention(h, null, 1);
    expect(r.keep).toEqual(["a"]);
    expect(r.delete).toEqual([]);
  });
  it("is empty for empty history", () => {
    expect(imageRetention([], null)).toEqual({ keep: [], delete: [] });
  });
});
