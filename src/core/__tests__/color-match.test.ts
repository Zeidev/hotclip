import { describe, it, expect } from "vitest";
import { MAX_BRIGHTNESS, MAX_SATURATION, pieceColorFilter, planPieceColorGrades } from "../color-match";

describe("piece colour matching", () => {
  it("leaves already-close pieces and the reference alone", () => {
    expect(planPieceColorGrades([{ luma: 100, saturation: 40 }, { luma: 103, saturation: 42 }])).toEqual([null, null]);
  });

  it("moves a visibly brighter piece toward the reference within the cap", () => {
    const grades = planPieceColorGrades([{ luma: 100, saturation: 40 }, { luma: 130, saturation: 40 }]);
    expect(grades[0]).toBeNull();
    expect(grades[1]).not.toBeNull();
    expect(grades[1]!.brightness).toBe(-MAX_BRIGHTNESS);
    expect(grades[1]!.saturation).toBe(1);
  });

  it("corrects saturation when only colour differs", () => {
    const grades = planPieceColorGrades([{ luma: 100, saturation: 40 }, { luma: 100, saturation: 50 }]);
    expect(grades[1]).toEqual({ brightness: 0, saturation: 1 - MAX_SATURATION });
  });

  it("never re-saturates monochrome, and skips unmeasured pieces", () => {
    expect(planPieceColorGrades([{ luma: 100, saturation: 3 }, { luma: 130, saturation: 3 }])).toEqual([null, null]);
    expect(planPieceColorGrades([{ luma: 100, saturation: 40 }, null])).toEqual([null, null]);
    expect(planPieceColorGrades([null, null])).toEqual([null, null]);
  });

  it("compiles a bounded eq and yields no filter for a null grade", () => {
    expect(pieceColorFilter({ brightness: -0.02, saturation: 1.05 })).toBe("eq=brightness=-0.020:saturation=1.050");
    expect(pieceColorFilter(null)).toBeNull();
    expect(pieceColorFilter({ brightness: 0, saturation: 1 })).toBeNull();
  });
});