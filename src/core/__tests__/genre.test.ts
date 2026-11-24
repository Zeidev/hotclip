import { describe, it, expect } from "vitest";
import {
  GENRE_PRESETS,
  GENRE_CUSTOM_MAX_CHARS,
  GENRE_CRITERIA_TR,
  GENRE_LABEL_TR,
  genreLabel,
  genrePreset,
  genreSection,
  normalizeGenreId,
} from "../genre";

describe("genrePreset", () => {
  it("按 id 取到对应预设", () => {
    expect(genrePreset("game").id).toBe("game");
    expect(genrePreset("show").labelZh).toContain("舞见");
  });

  it("未知/空 id 回落通用档,不抛异常", () => {
    expect(genrePreset("不存在的品类").id).toBe("auto");
    expect(genrePreset(undefined).id).toBe("auto");
  });

  it("每个内置预设中英文都有标签,且除 auto/custom 外都有判据", () => {
    for (const g of GENRE_PRESETS) {
      expect(g.labelZh).not.toBe("");
      expect(g.labelEn).not.toBe("");
      if (g.id !== "auto" && g.id !== "custom") {
        expect(g.criteriaZh.length).toBeGreaterThan(50);
        expect(g.criteriaEn.length).toBeGreaterThan(50);
      }
    }
  });

  it("土耳其语表齐全:每个品类都有显示名,除 auto/custom 外都有判据", () => {
    for (const g of GENRE_PRESETS) {
      expect(GENRE_LABEL_TR[g.id]).toBeTruthy();
      if (g.id === "auto" || g.id === "custom") {
        expect(GENRE_CRITERIA_TR[g.id]).toBe("");
      } else {
        expect(GENRE_CRITERIA_TR[g.id].length).toBeGreaterThan(50);
      }
    }
    // 表按 GenreId 收口,不多也不少(多写的键 TS 就会红,这里守运行时)
    expect(Object.keys(GENRE_LABEL_TR).sort()).toEqual(GENRE_PRESETS.map((g) => g.id).sort());
    expect(Object.keys(GENRE_CRITERIA_TR).sort()).toEqual(GENRE_PRESETS.map((g) => g.id).sort());
  });

  it("id 不重复(下拉里不许出现两个同名项)", () => {
    const ids = GENRE_PRESETS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("分区口径对齐平台真实分类", () => {
  // 分区表按 B站直播 Area/getList(11 个一级分区)+ 抖音/斗鱼公开分区归并而来。
  // 这些是我自己拍脑袋列时漏掉、看了真实分类才补上的品类——回归时要守住。
  it("覆盖 B站一级分区里容易被漏掉的几类", () => {
    const ids = GENRE_PRESETS.map((g) => g.id);
    for (const must of ["vtuber", "radio", "pet", "food", "esports", "craft", "cowatch", "looks", "sports"]) {
      expect(ids).toContain(must);
    }
  });

  it("每个预设都标了证据类别,且三类都有代表", () => {
    const classes = new Set(GENRE_PRESETS.map((g) => g.evidence));
    expect(classes).toEqual(new Set(["words", "reaction", "visual"]));
    // 文字稿最没用的那几类必须不是 words,否则信号通道根本不会跑
    for (const id of ["show", "pet", "food", "craft"]) {
      expect(genrePreset(id).evidence).toBe("visual");
    }
    for (const id of ["game", "outdoor", "vtuber", "radio", "esports"]) {
      expect(genrePreset(id).evidence).toBe("reaction");
    }
  });

  it("旧偏好里的 id 仍然认(分区重排不能让本机设置失效)", () => {
    expect(normalizeGenreId("live-sell")).toBe("shopping");
    expect(normalizeGenreId("gaming")).toBe("game");
    expect(normalizeGenreId("lecture")).toBe("knowledge");
    expect(normalizeGenreId("show")).toBe("show");
    expect(normalizeGenreId(undefined)).toBeUndefined();
    // 走到 genreSection 也要真的拿到新判据
    expect(genreSection("live-sell", "zh")).toContain("带货直播");
  });
});

describe("genreSection", () => {
  it("通用档不注入任何内容(保持原有通用判据)", () => {
    expect(genreSection("auto", "zh")).toBe("");
    expect(genreSection(undefined, "en")).toBe("");
  });

  it("按语言给对应判据", () => {
    expect(genreSection("shopping", "zh")).toContain("带货直播");
    expect(genreSection("shopping", "en")).toContain("Live-selling");
  });

  it("自定义判据盖过内置预设(选个最接近的再改两句)", () => {
    const out = genreSection("game", "zh", "只要老板骂人的片段");
    expect(out).toContain("只要老板骂人的片段");
    expect(out).not.toContain("极限操作");
  });

  it("空白自定义不算数,仍用预设", () => {
    expect(genreSection("game", "zh", "   ")).toContain("极限操作");
    expect(genreSection("game", "zh", "")).toContain("极限操作");
  });

  it("自定义判据超长会被截断(不许塞爆提示词)", () => {
    const huge = "很长的判据".repeat(1000);
    const out = genreSection("custom", "zh", huge);
    expect(out.length).toBeLessThan(GENRE_CUSTOM_MAX_CHARS + 100);
  });

  it("custom 预设自身没有内置判据,没填自定义就不注入", () => {
    expect(genreSection("custom", "zh")).toBe("");
  });

  it("文字稿不可信的品类都明说了别信文字稿", () => {
    expect(genreSection("game", "zh")).toContain("不要只看文字稿");
    expect(genreSection("show", "zh")).toContain("文字稿基本没有信息量");
    expect(genreSection("pet", "zh")).toContain("文字稿完全不能作为判据");
    expect(genreSection("outdoor", "zh")).toContain("户外收音差");
  });

  it("虚拟主播档点明表情信号无效(脸是模型不是人)", () => {
    expect(genreSection("vtuber", "zh")).toContain("人脸表情信号基本无效");
  });

  it("电台档点明没有画面(纯音频成片走波形图)", () => {
    expect(genreSection("radio", "zh")).toContain("没有画面可用");
  });

  it("一起看档把版权风险写在最前面——这条比选得好不好重要", () => {
    const out = genreSection("cowatch", "zh");
    expect(out).toContain("版权");
    expect(out).toContain("不要把影视画面本身切成片");
  });
});

describe("土耳其语品类", () => {
  it("标题行是土耳其语,不是英文也不是中文", () => {
    const out = genreSection("shopping", "tr");
    expect(out.startsWith("\n\n[Yayın türü ve ölçütler] ")).toBe(true);
    expect(out).not.toContain("[Stream type & criteria]");
    expect(out).not.toContain("【本场类型与判据】");
  });

  it("tr 判据与 en 不是同一份文本(否则加这张表没意义)", () => {
    for (const g of GENRE_PRESETS) {
      if (g.id === "auto" || g.id === "custom") continue;
      expect(GENRE_CRITERIA_TR[g.id]).not.toBe(g.criteriaEn);
    }
  });

  it("tr 判据不泄漏中日韩文字(中文分区名不能进土耳其语提示词)", () => {
    for (const g of GENRE_PRESETS) {
      const body = GENRE_LABEL_TR[g.id] + GENRE_CRITERIA_TR[g.id];
      expect(body).not.toMatch(/[一-鿿ぁ-ゟ゠-ヿ]/);
    }
  });

  it("关键品类保留各自的硬规则(不能译丢)", () => {
    expect(genreSection("cowatch", "tr")).toContain("telifli");
    expect(genreSection("game", "tr")).toContain("yalnızca metne bakma");
    expect(genreSection("pet", "tr")).toContain("konuşamıyor");
    expect(genreSection("radio", "tr")).toContain("görüntü yok");
  });

  it("tr 下 auto/custom 同样不注入", () => {
    expect(genreSection("auto", "tr")).toBe("");
    expect(genreSection("custom", "tr")).toBe("");
  });

  it("自定义判据在 tr 下同样盖过内置预设", () => {
    const out = genreSection("game", "tr", "sadece patronun bağırdığı yerler");
    expect(out).toContain("sadece patronun bağırdığı yerler");
    expect(out).not.toContain("kritik hamle");
  });

  it("旧 id 在 tr 下也走到新判据", () => {
    expect(genreSection("live-sell", "tr")).toContain("canlı satış");
  });
});

describe("genreLabel", () => {
  it("按语言取显示名,三语互不相同", () => {
    const shopping = genrePreset("shopping");
    expect(genreLabel(shopping, "zh")).toBe(shopping.labelZh);
    expect(genreLabel(shopping, "en")).toBe(shopping.labelEn);
    expect(genreLabel(shopping, "tr")).toBe(GENRE_LABEL_TR.shopping);
    expect(genreLabel(shopping, "tr")).not.toBe(shopping.labelEn);
  });

  it("下拉里每个选项都有非空名字(空选项是可见的 bug)", () => {
    for (const g of GENRE_PRESETS) {
      for (const lang of ["zh", "tr", "en"] as const) {
        expect(genreLabel(g, lang).length).toBeGreaterThan(0);
      }
    }
  });
});
