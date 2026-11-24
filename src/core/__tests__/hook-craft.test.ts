/**
 * 写法教义(hook-craft):它是直接拼进系统提示词的字符串,一旦漏了某个语言
 * 的分支、或者英文块里混进中文,提示词就悄悄坏掉(品类判据踩过这个坑),
 * 所以这里把「三语都在、语言不串、不含时长档位字符串」钉死。
 */
import { describe, it, expect } from "vitest";
import { HOOK_MECHANICS, hookCraftSection, onScreenHookRules } from "../hook-craft";

const LANGS = ["zh", "tr", "en"] as const;
const CJK = /[一-鿿]/;
const TURKISH_LETTERS = /[ğĞıİşŞçÇöÖüÜ]/;
/** highlightSystemPrompt 会 replace 这些时长档位字符串——教义块里绝不能有。 */
const LENGTH_TIERS = ["8~40 秒", "8–40 seconds", "8–40 saniye", "60~120 秒", "40~90 秒"];

describe("hookCraftSection", () => {
  it("三语区块都非空、以标题行开头、同一语言稳定同文", () => {
    for (const lang of LANGS) {
      const s = hookCraftSection(lang);
      expect(s.trim().length).toBeGreaterThan(200);
      expect(s.startsWith("\n\n【")).toBe(true);
      expect(hookCraftSection(lang)).toBe(s);
    }
  });

  it("五种机制齐全,各自的名称/规则/正反例都在块里", () => {
    expect(HOOK_MECHANICS).toHaveLength(5);
    expect(new Set(HOOK_MECHANICS.map((m) => m.id)).size).toBe(5);
    for (const lang of LANGS) {
      const s = hookCraftSection(lang);
      for (const m of HOOK_MECHANICS) {
        expect(m.name[lang].trim()).not.toBe("");
        expect(s).toContain(m.name[lang]);
        expect(s).toContain(m.rule[lang]);
        expect(s).toContain(m.fix.bad[lang]);
        expect(s).toContain(m.fix.good[lang]);
      }
    }
  });

  it("语言不串:en/tr 块无中文,zh 块无土耳其语字母", () => {
    expect(CJK.test(hookCraftSection("en"))).toBe(false);
    expect(CJK.test(hookCraftSection("tr"))).toBe(false);
    expect(TURKISH_LETTERS.test(hookCraftSection("zh"))).toBe(false);
    expect(TURKISH_LETTERS.test(hookCraftSection("en"))).toBe(false);
  });

  it("机制名与正反例按语言原生,不是互抄", () => {
    for (const m of HOOK_MECHANICS) {
      expect(m.name.zh).not.toBe(m.name.en);
      expect(m.fix.good.zh).not.toBe(m.fix.good.en);
      expect(m.fix.good.tr).not.toBe(m.fix.good.en);
    }
  });

  it("不含时长档位字符串(否则会被时长改写误伤)", () => {
    for (const lang of LANGS) {
      const s = hookCraftSection(lang);
      for (const tier of LENGTH_TIERS) expect(s).not.toContain(tier);
    }
  });
});

describe("onScreenHookRules", () => {
  it("三语都短,且明显短于完整教义(评审提示词塞不下长块)", () => {
    for (const lang of LANGS) {
      const short = onScreenHookRules(lang);
      expect(short.trim().length).toBeGreaterThan(20);
      expect(short.length).toBeLessThan(hookCraftSection(lang).length);
    }
  });

  it("en/tr 短块同样不夹中文", () => {
    expect(CJK.test(onScreenHookRules("en"))).toBe(false);
    expect(CJK.test(onScreenHookRules("tr"))).toBe(false);
  });
});
