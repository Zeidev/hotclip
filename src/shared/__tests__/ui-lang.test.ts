/**
 * 写给创作者的产物的语言判定:界面语言 → 三语。这里钉死两条口径:
 * 1) 未知/缺省 locale 一律中文——CLI 与 MCP 不传 locale,输出必须与历史一致;
 * 2) 只有 tr/en 走非中文,别的语言(ja/ko/...)不猜,落到中文。
 */
import { describe, it, expect } from "vitest";
import { uiLang, AIGC_BADGE_TEXT, AIGC_POST_NOTE } from "../ui-lang";

describe("uiLang", () => {
  it("tr/en 原样,其余(含缺省/未知/非字符串)一律 zh", () => {
    expect(uiLang("tr")).toBe("tr");
    expect(uiLang("en")).toBe("en");
    expect(uiLang("zh")).toBe("zh");
    expect(uiLang(undefined)).toBe("zh");
    expect(uiLang(null)).toBe("zh");
    expect(uiLang("")).toBe("zh");
    expect(uiLang("ja")).toBe("zh");
    expect(uiLang(1)).toBe("zh");
  });
});

describe("creator-facing 文案三语齐备", () => {
  it("AIGC 标识与 .post.txt 提醒三语都有,且都不是空串", () => {
    for (const lang of ["zh", "tr", "en"] as const) {
      expect(AIGC_BADGE_TEXT[lang].trim().length).toBeGreaterThan(0);
      expect(AIGC_POST_NOTE[lang].trim().length).toBeGreaterThan(0);
    }
    expect(AIGC_BADGE_TEXT.zh).toBe("AI 生成");
    expect(AIGC_POST_NOTE.tr).toContain("AIGC beyanı");
  });
});
