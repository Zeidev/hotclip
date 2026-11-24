/**
 * 实用密度信号:三语都要能算。土耳其语侧只用完整词形(「ilk adım」
 * 「3 yöntem」),裸「adım/yol」不收——它们会扫到日常口语。
 */
import { describe, it, expect } from "vitest";
import { utilityDensity, utilityBoost, UTILITY_SAVE_WORTHY } from "../utility-density";

describe("utilityDensity (实用密度)", () => {
  it("中文步骤/清单/干货词命中", () => {
    const d = utilityDensity("首先教大家三个方法,第二步很关键,最后一步是避坑");
    expect(d.score).toBeGreaterThanOrEqual(UTILITY_SAVE_WORTHY);
    expect(d.hits.length).toBeGreaterThan(0);
  });

  it("英文步骤/清单词命中", () => {
    const d = utilityDensity("First, here are 3 tips. Second, finally check the recipe.");
    expect(d.score).toBeGreaterThanOrEqual(UTILITY_SAVE_WORTHY);
  });

  it("土耳其语步骤/清单/方法论词命中", () => {
    const d = utilityDensity(
      "İlk olarak hamuru hazırlıyoruz, ardından 3 yöntem deneyeceğiz, son olarak fırına veriyoruz"
    );
    expect(d.score).toBeGreaterThanOrEqual(UTILITY_SAVE_WORTHY);
    expect(d.hits).toContain("İlk olarak");
    expect(d.hits.some((h) => /yöntem/i.test(h))).toBe(true);
  });

  it("土耳其语「N + 干货名词」清单结构命中(3 hata / iki yöntem)", () => {
    expect(utilityDensity("Bu 3 hata çok yaygın").hits.some((h) => h.includes("hata"))).toBe(true);
    expect(utilityDensity("Size iki yöntem göstereyim").score).toBeGreaterThan(0);
  });

  it("土耳其语机制类词命中(püf noktası / rehber / nasıl yapılır)", () => {
    expect(utilityDensity("İşin püf noktası burada").score).toBeGreaterThan(0);
    expect(utilityDensity("Bu bir rehber niteliğinde").score).toBeGreaterThan(0);
    expect(utilityDensity("Nasıl yapılır diye soranlara").score).toBeGreaterThan(0);
  });

  it("土耳其语日常口语不误报(只收完整词形)", () => {
    // «adım» 同时是「我的名字」,«yol» 在 yolcu/yolculuk 里都有——都不收
    expect(utilityDensity("Merhaba arkadaşlar, bugün çok yorgunum").score).toBe(0);
    expect(utilityDensity("Adım Ahmet, bu yolu çok sevdim").score).toBe(0);
    expect(utilityDensity("Yolcular beklemekten sıkıldı").score).toBe(0);
  });

  it("分数封顶 10,加分按分数线阶梯", () => {
    const d = utilityDensity(
      "首先三个方法,其次5个技巧,第三步配方,第四步口诀,第五步教程,最后一步清单,3.14 和 2026"
    );
    expect(d.score).toBeLessThanOrEqual(10);
    expect(utilityBoost(d.score)).toBeLessThanOrEqual(6);
    expect(utilityBoost(0)).toBe(0);
    expect(utilityBoost(UTILITY_SAVE_WORTHY)).toBe(2);
  });

  it("空文本返回 0", () => {
    expect(utilityDensity("")).toEqual({ score: 0, hits: [] });
  });
});
