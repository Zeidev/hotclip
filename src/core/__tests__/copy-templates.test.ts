import { describe, it, expect } from "vitest";
import {
  isHookAngle,
  isCtaType,
  hookAngleMenu,
  ctaMenu,
  hookAngleLabel,
  ctaTypeLabel,
} from "../copy-templates";

describe("校验器", () => {
  it("菜单内 id 通过,菜单外/非字符串拒绝", () => {
    expect(isHookAngle("question")).toBe(true);
    expect(isHookAngle("urgency")).toBe(true);
    expect(isHookAngle("clickbait")).toBe(false);
    expect(isHookAngle(1)).toBe(false);
    expect(isCtaType("product")).toBe(true);
    expect(isCtaType("buy_now")).toBe(false);
    expect(isCtaType(undefined)).toBe(false);
  });
});

describe("提示词菜单", () => {
  it("中文菜单 8 角度 5 CTA,每行带 id 与用法", () => {
    const angles = hookAngleMenu("zh").split("\n");
    expect(angles.length).toBe(8);
    expect(angles[0]).toContain("question=提问式");
    const ctas = ctaMenu("zh").split("\n");
    expect(ctas.length).toBe(5);
    expect(ctas.some((l) => l.startsWith("product=商品引导"))).toBe(true);
  });

  it("高危角度/CTA 的提示里带红线(与违禁词 lint 呼应)", () => {
    expect(hookAngleMenu("zh")).toContain("禁编造截止");
    expect(ctaMenu("zh")).toContain("禁站外导流");
  });

  it("英文菜单同样成行", () => {
    expect(hookAngleMenu("en").split("\n").length).toBe(8);
    expect(ctaMenu("en").split("\n").length).toBe(5);
  });

  it("土耳其语菜单成行,且不夹带中文", () => {
    const angles = hookAngleMenu("tr").split("\n");
    expect(angles.length).toBe(8);
    expect(ctaMenu("tr").split("\n").length).toBe(5);
    for (const line of [...angles, ...ctaMenu("tr").split("\n")]) {
      expect(line).not.toMatch(/[一-鿿]/);
    }
  });

  it("土耳其语红线与中文口径一致(禁编造截止、禁站外导流)", () => {
    expect(hookAngleMenu("tr")).toContain("uydurma son tarih");
    expect(ctaMenu("tr")).toContain("platform dışına yönlendirme");
  });
});

describe("标签", () => {
  it("已知 id 出人类可读名,未知 id 原样返回", () => {
    expect(hookAngleLabel("pain", "zh")).toBe("痛点共鸣");
    expect(hookAngleLabel("pain", "en")).toBe("pain");
    expect(ctaTypeLabel("save", "zh")).toBe("收藏回看");
    expect(hookAngleLabel("mystery", "zh")).toBe("mystery");
  });

  it("土耳其语标签三语共用 id", () => {
    expect(hookAngleLabel("pain", "tr")).toBe("sorun");
    expect(ctaTypeLabel("save", "tr")).toBe("kaydet");
  });
});
