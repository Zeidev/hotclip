import { describe, expect, it } from "vitest";
import { searchVisualEvidence } from "../evidence-search";

describe("searchVisualEvidence", () => {
  const notes = [
    { t: 30, energy: 7, note: "产品展示", visibleText: ["三层加厚", "¥2.9"] },
    { t: 10, energy: 5, note: "主持人讲解", visibleText: ["HotClip"] },
    { t: 20, energy: 8, note: "价格牌特写", visibleText: ["¥2.9"] },
  ];

  it("matches descriptions and confirmed screen text with compatibility normalization", () => {
    expect(searchVisualEvidence(notes, "价格").map((hit) => hit.t)).toEqual([20]);
    expect(searchVisualEvidence(notes, "￥2.9").map((hit) => hit.t)).toEqual([20, 30]);
    expect(searchVisualEvidence(notes, "hotclip")[0]).toMatchObject({ t: 10, match: "screen-text" });
  });

  it("sorts, bounds and ignores malformed timestamps", () => {
    const result = searchVisualEvidence([
      ...notes,
      { t: -1, energy: 9, note: "价格" },
      { t: Number.NaN, energy: 9, note: "价格" },
      { t: 5, energy: 9, note: "价格" },
    ], "价格", 2);
    expect(result.map((hit) => hit.t)).toEqual([5, 20]);
    expect(searchVisualEvidence(notes, "价格", 0)).toEqual([]);
  });

  it("fails closed for empty input and avoids duplicate note keys", () => {
    expect(searchVisualEvidence(undefined, "价格")).toEqual([]);
    expect(searchVisualEvidence(notes, "")).toEqual([]);
    expect(searchVisualEvidence([
      { ...notes[0] },
      { ...notes[0] },
    ], "产品")).toHaveLength(1);
  });
});
