/**
 * 土耳其语界面的回归钉子。用户是土耳其语内容创作者,他们看到的第一屏不该是中文,
 * 也不该是半截英文。这里钉住三件事:
 *  - tr 已注册且出现在 LOCALE_LIST 里(切换器/设置页从它推导,不用改别处);
 *  - tr 覆盖 en 的每一个 key —— 缺 key 时 translate() 的兜底是 en 再到 zh,
 *    所以真正的风险是「tr 漏 key 却没人发现」,而不是兜底顺序;
 *  - 主进程报告类文本只有 zh/en 两种,tr 界面拿到 en(不能拿到中文)。
 */
import { describe, expect, it } from "vitest";
import { LOCALE_LIST, REGISTRY, intlLocale, reportLocale, translate } from "../messages";
import { en } from "../locales/en";
import { tr } from "../locales/tr";

const HAN = /[一-鿿]/;
const trT = (ns: string, key: string): string => translate("tr", ns, key);

describe("Turkish locale registration", () => {
  it("is installed and listed for the switcher and the settings list", () => {
    expect(REGISTRY.tr.label).toBe("Türkçe");
    expect(LOCALE_LIST).toContain("tr");
  });

  it("covers every key English defines, so no stage of the UI falls back", () => {
    const missing: string[] = [];
    for (const namespace of Object.keys(en)) {
      for (const key of Object.keys((en as Record<string, Record<string, string>>)[namespace])) {
        if (!(key in ((tr as Record<string, Record<string, string>>)[namespace] ?? {}))) {
          missing.push(`${namespace}.${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("never resolves one of its own keys to the key itself or to Chinese", () => {
    for (const key of ["detectingNow", "exportOverlayTitle", "settingsTitle", "detectElapsed"]) {
      const text = trT("workbench", key);
      expect(text).not.toBe(key);
      expect(text).not.toMatch(HAN);
    }
    expect(trT("highlights", "reasonLabel")).not.toMatch(HAN);
    expect(trT("watch", "modeWebhook")).not.toMatch(HAN);
  });

  it("writes the detection stages in Turkish, one line each", () => {
    expect(trT("workbench", "detectStage_select")).toContain("öne çıkanları");
    expect(trT("workbench", "detectStage_prefilter")).not.toMatch(HAN);
    expect(trT("workbench", "detectElapsed")).toContain("{t}");
  });

  it("falls back to the key for a namespace that does not exist", () => {
    expect(translate("tr", "nope", "nothing")).toBe("nothing");
  });
});

describe("main-process report text stays bilingual", () => {
  it("sends a Turkish UI to English rather than to Chinese", () => {
    expect(reportLocale("tr")).toBe("en");
    expect(reportLocale("en")).toBe("en");
    expect(reportLocale("zh")).toBe("zh");
  });

  it("formats dates and numbers in Turkish", () => {
    expect(intlLocale("tr")).toBe("tr-TR");
    expect(intlLocale("zh")).toBe("zh-CN");
    expect(intlLocale("en")).toBe("en-US");
  });
});
