import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CLIPS, MAX_CLIPS, normalizeMaxClips } from "../detection-options";

describe("normalizeMaxClips", () => {
  it("keeps an in-range count and rounds fractions", () => {
    expect(normalizeMaxClips(1)).toBe(1);
    expect(normalizeMaxClips(12)).toBe(12);
    expect(normalizeMaxClips(20)).toBe(20);
    expect(normalizeMaxClips(MAX_CLIPS)).toBe(40);
    expect(normalizeMaxClips(9.4)).toBe(9);
  });

  it("clamps above the ceiling and below one", () => {
    expect(normalizeMaxClips(41)).toBe(MAX_CLIPS);
    expect(normalizeMaxClips(999)).toBe(MAX_CLIPS);
    expect(normalizeMaxClips(0)).toBe(1);
    expect(normalizeMaxClips(-5)).toBe(1);
  });

  it("falls back to the default for missing or invalid input", () => {
    expect(normalizeMaxClips(undefined)).toBe(DEFAULT_MAX_CLIPS);
    expect(normalizeMaxClips(null)).toBe(DEFAULT_MAX_CLIPS);
    expect(normalizeMaxClips(NaN)).toBe(DEFAULT_MAX_CLIPS);
    expect(normalizeMaxClips(Infinity)).toBe(DEFAULT_MAX_CLIPS);
    expect(normalizeMaxClips("20")).toBe(DEFAULT_MAX_CLIPS);
  });

  it("uses 12 as the documented default and 40 as the ceiling", () => {
    expect(DEFAULT_MAX_CLIPS).toBe(12);
    expect(MAX_CLIPS).toBe(40);
  });
});
