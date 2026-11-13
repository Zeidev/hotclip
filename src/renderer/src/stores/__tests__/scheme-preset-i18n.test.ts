/**
 * 硬编码中文回归:v0.34.1 之前方案名/供应商名/预设名写死在 store 里,
 * 英文(和土耳其语用户看到的英文)界面上直接漏出中文。这里钉住三件事:
 *  - 内置方案只留 nameKey,显示名走 i18n;
 *  - 有中文兜底名的供应商预设必须有 labelKey,且 en 译名不含汉字;
 *  - 用户自己起的名字原样保留(那是用户数据,不该被"翻译")。
 */
import { describe, expect, it } from "vitest";
import { translate, translateNow } from "../../i18n/messages";
import { LLM_PRESET_LIST } from "../llm-store";
import { BUILTIN_SCHEMES, schemeLabel } from "../scheme-store";

const HAN = /[一-鿿]/;
const en = (key: string): string => translate("en", "workbench", key);
const enHighlights = (key: string): string => translate("en", "highlights", key);
const zh = (key: string): string => translate("zh", "workbench", key);

describe("scheme names are localized (v0.34.1)", () => {
  it("built-in schemes carry an i18n key instead of a hardcoded name", () => {
    expect(BUILTIN_SCHEMES.length).toBeGreaterThan(0);
    for (const s of BUILTIN_SCHEMES) expect(s.nameKey).toBeTruthy();
  });

  it("built-in names render in the active locale", () => {
    expect(schemeLabel(BUILTIN_SCHEMES[0], en)).toBe("Default export");
    expect(schemeLabel(BUILTIN_SCHEMES[1], en)).toBe("Full selling kit");
    expect(schemeLabel(BUILTIN_SCHEMES[2], en)).toBe("Minimal & fast");
  });

  it("no built-in name leaks Chinese into en, and zh keeps its own wording", () => {
    for (const s of BUILTIN_SCHEMES) {
      expect(en(s.nameKey as string)).not.toMatch(HAN);
      expect(zh(s.nameKey as string)).toMatch(HAN);
    }
  });

  it("keeps a user-chosen scheme name exactly as stored", () => {
    const mine = { id: "user-1", name: "周更三件套", prefs: BUILTIN_SCHEMES[0].prefs };
    expect(schemeLabel(mine, en)).toBe("周更三件套");
  });
});

describe("provider + preset names are localized (v0.34.1)", () => {
  it("every preset whose fallback label is Chinese has a labelKey translated in en", () => {
    for (const preset of LLM_PRESET_LIST) {
      if (!HAN.test(preset.label)) continue;
      expect(preset.labelKey, `${preset.id} needs a labelKey`).toBeTruthy();
      expect(enHighlights(preset.labelKey as string)).not.toMatch(HAN);
    }
  });

  it("auto-generated names follow the persisted locale, never a hardcoded zh string", () => {
    // node 里没有 localStorage:storedLocale() 回落 en,所以兜底名不该是中文
    expect(translateNow("brand", "forkPresetName")).not.toMatch(HAN);
    expect(translateNow("workbench", "schemeFallbackName")).not.toMatch(HAN);
  });
});
