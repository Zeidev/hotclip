/**
 * 本地质检(hook-quality):判定必须「宁可漏、不可误伤」——误报会让发布文案
 * 白花第二次调用、把好标题改坏。所以这里既钉真阳性(套话/超长/重复/角度撞车),
 * 也钉假阳性(「Bugün 40 derece」这种正常句子不能中招),并覆盖土耳其语
 * İ/ı 折叠(直接 toLowerCase 会得到 i + U+0307,永远匹配不到 ASCII)。
 */
import { describe, it, expect } from "vitest";
import { checkHookQuality, countUnits, hookFlagNotes, filterDuplicatePackagings, ungroundedSpans, type HookCandidate } from "../hook-quality";

const zh = (items: HookCandidate[]) => checkHookQuality(items, { lang: "zh", surface: "publish" });
const codesOf = (flags: ReturnType<typeof checkHookQuality>, id: number) => flags.find((f) => f.id === id)?.codes ?? [];

describe("countUnits", () => {
  it("chars 按码点(emoji 不劈半),words 按空白", () => {
    expect(countUnits("🎬差价10倍!", "chars")).toBe(7);
    expect(countUnits("  a  b   c ", "words")).toBe(3);
    expect(countUnits("   ", "chars")).toBe(0);
    expect(countUnits("", "words")).toBe(0);
  });
});

describe("checkHookQuality — 空/超长", () => {
  it("空字段单独点名", () => {
    expect(codesOf(zh([{ id: 1, title: "   " }]), 1)).toContain("empty");
  });

  it("中文发布标题正好 30 字干净,31 字点名(硬上限,一个字都不放)", () => {
    expect(zh([{ id: 1, title: "差".repeat(30) }])).toHaveLength(0);
    const flags = zh([{ id: 1, title: "差".repeat(31) }]);
    expect(codesOf(flags, 1)).toContain("too-long");
    expect(flags[0].detail).toContain("31 > 30");
  });

  it("土耳其语发布标题 60 字内干净,61 字点名", () => {
    expect(checkHookQuality([{ id: 1, title: "a".repeat(60) }], { lang: "tr", surface: "publish" })).toHaveLength(0);
    expect(codesOf(checkHookQuality([{ id: 1, title: "a".repeat(61) }], { lang: "tr", surface: "publish" }), 1)).toContain(
      "too-long"
    );
  });

  it("悬念句另有硬闸:超过 30 字会被 slice(0,30) 无声截断", () => {
    // 英文变体悬念句上限 36 字,34 字没过字数上限,但过不了 30 字截断闸
    const flags = checkHookQuality([{ id: 1, title: "", teaser: "a".repeat(34) }], { lang: "en", surface: "variantTeaser" });
    expect(codesOf(flags, 1)).toContain("too-long");
    expect(flags[0].field).toBe("teaser");
    expect(flags[0].detail).toContain("on-screen slice");
  });

  it("悬念句出口读 teaser 字段,不拿 title 顶替", () => {
    expect(checkHookQuality([{ id: 1, title: "今天聊聊吸水性", teaser: "半杯水都不渗" }], { lang: "zh", surface: "teaser" })).toHaveLength(0);
    expect(codesOf(checkHookQuality([{ id: 1, title: "半杯水都不渗" }], { lang: "zh", surface: "teaser" }), 1)).toContain("empty");
  });

  it("中文悬念句 15 字内干净,16 字点名", () => {
    expect(checkHookQuality([{ id: 1, title: "", teaser: "差".repeat(15) }], { lang: "zh", surface: "teaser" })).toHaveLength(0);
    expect(
      codesOf(checkHookQuality([{ id: 1, title: "", teaser: "差".repeat(16) }], { lang: "zh", surface: "teaser" }), 1)
    ).toContain("too-long");
  });
});

describe("checkHookQuality — 开场套话", () => {
  it("三语常见填充开场都抓得到", () => {
    expect(codesOf(zh([{ id: 1, title: "今天聊聊吸水性问题" }]), 1)).toContain("generic-opener");
    expect(codesOf(zh([{ id: 1, title: "“大家好”,今天说个事" }]), 1)).toContain("generic-opener"); // 引号先剥掉
    expect(
      codesOf(checkHookQuality([{ id: 1, title: "Merhaba arkadaşlar, bugün şunu konuşalım" }], { lang: "tr", surface: "publish" }), 1)
    ).toContain("generic-opener");
    expect(
      codesOf(checkHookQuality([{ id: 1, title: "In this video I show you the trick" }], { lang: "en", surface: "publish" }), 1)
    ).toContain("generic-opener");
  });

  it("土耳其语 İ/ı 折叠:İyi akşamlar / Şimdi bakalım 都命中", () => {
    const t = (title: string) => codesOf(checkHookQuality([{ id: 1, title }], { lang: "tr", surface: "publish" }), 1);
    expect(t("İyi akşamlar, bugünkü konu şu")).toContain("generic-opener");
    expect(t("Şimdi bakalım bu ürün ne yapıyor")).toContain("generic-opener");
    expect(t("İYİ AKŞAMLAR, hoş geldiniz")).toContain("generic-opener");
  });

  it("正常句子不误伤:单独的 bugün/şimdi 不算套话", () => {
    const t = (title: string) => codesOf(checkHookQuality([{ id: 1, title }], { lang: "tr", surface: "publish" }), 1);
    expect(t("Bugün 40 derece, bu yüzden klima çalışmıyor")).toEqual([]);
    expect(t("Kutuyu böyle kaldırmayı bırak, belin ağrır")).toEqual([]);
    expect(zh([{ id: 1, title: "半杯水都不渗,这张纸凭什么" }])).toHaveLength(0);
    expect(
      codesOf(checkHookQuality([{ id: 1, title: "Stop lifting boxes like this" }], { lang: "en", surface: "publish" }), 1)
    ).toEqual([]);
  });
});

describe("checkHookQuality — 标签与风险词", () => {
  it("标题里塞 hashtag 点名", () => {
    expect(codesOf(zh([{ id: 1, title: "差价10倍的真相 #实测" }]), 1)).toContain("hashtag-in-title");
  });

  it("风险词复用 content-lint 规则表,标题与简介一起扫", () => {
    expect(
      codesOf(checkHookQuality([{ id: 1, title: "Bu ürün en iyi seçim" }], { lang: "tr", surface: "publish" }), 1)
    ).toContain("risk-word");
    expect(
      codesOf(checkHookQuality([{ id: 1, title: "Kısa video", description: "bu krem kanseri tedavi eder" }], { lang: "tr", surface: "publish" }), 1)
    ).toContain("risk-word");
  });
});

describe("checkHookQuality — 重复与角度", () => {
  it("整段只差标点的两条标题判重复(只点名后一条)", () => {
    const flags = zh([{ id: 1, title: "差价10倍" }, { id: 2, title: "差价10倍!" }]);
    expect(flags.map((f) => f.id)).toEqual([2]);
    expect(codesOf(flags, 2)).toContain("duplicate");
    expect(flags[0].detail).toContain("[1]");
  });

  it("真正不同的标题不算重复", () => {
    expect(zh([{ id: 1, title: "差价10倍" }, { id: 2, title: "为什么不渗水" }, { id: 3, title: "桌上一杯水倒了三天" }])).toHaveLength(0);
  });

  it("短标题不参与相似度判定(「差价10倍」这类容易撞 bigram)", () => {
    expect(zh([{ id: 1, title: "A" }, { id: 2, title: "B" }])).toHaveLength(0);
  });

  it("三语重复都抓得到", () => {
    const tr = checkHookQuality(
      [{ id: 1, title: "Ekmeği kesmeden 6 kilo verdim" }, { id: 2, title: "Ekmeği kesmeden 6 kilo verdim!" }],
      { lang: "tr", surface: "publish" }
    );
    expect(codesOf(tr, 2)).toContain("duplicate");
    const en = checkHookQuality(
      [{ id: 1, title: "Washed this morning, oily by noon" }, { id: 2, title: "Washed this morning — oily by noon" }],
      { lang: "en", surface: "publish" }
    );
    expect(codesOf(en, 2)).toContain("duplicate");
  });

  it("角度重复只在成规模的批次里算问题(三条同角度 → 后两条点名)", () => {
    const flags = zh([
      { id: 1, title: "半杯水都不渗,这张纸凭什么", angle: "pain" },
      { id: 2, title: "为什么不渗水", angle: "pain" },
      { id: 3, title: "桌上一杯水倒了三天", angle: "pain" },
    ]);
    expect(flags.map((f) => f.id)).toEqual([2, 3]);
    expect(flags[0].detail).toContain("pain = [1]");
  });

  it("两条撞角度不算整批一个套路,不点名", () => {
    const flags = zh([
      { id: 1, title: "半杯水都不渗,这张纸凭什么", angle: "pain" },
      { id: 2, title: "为什么不渗水", angle: "pain" },
    ]);
    expect(flags).toHaveLength(0);
  });
});

describe("hookFlagNotes", () => {
  it("逐条写成本地语言的返工清单", () => {
    const flags = checkHookQuality([{ id: 1, title: "今天聊聊吸水性" }], { lang: "zh", surface: "publish" });
    expect(hookFlagNotes(flags, "zh")).toContain("[1]");
    expect(hookFlagNotes(flags, "zh")).toContain("套话");
    const trFlags = checkHookQuality([{ id: 1, title: "Merhaba arkadaşlar" }], { lang: "tr", surface: "publish" });
    const trNotes = hookFlagNotes(trFlags, "tr");
    expect(trNotes).toContain("[1]");
    expect(trNotes).toContain("kalıp söz");
    expect(trNotes).not.toMatch(/[一-鿿]/);
  });
});

describe("filterDuplicatePackagings", () => {
  const get = (v: { title: string; angle?: "pain" | "question" }) => v;

  it("与原标题一字不差的丢掉,真的不同的留下", () => {
    const out = filterDuplicatePackagings(
      [{ title: "原标题" }, { title: "真的不同" }],
      get,
      { title: "原标题" },
      "zh"
    );
    expect(out.map((v) => v.title)).toEqual(["真的不同"]);
  });

  it("几乎同一句话(只差标点)也丢掉,不只看一字不差", () => {
    const out = filterDuplicatePackagings(
      [{ title: "半杯水都不渗,这张纸凭什么" }, { title: "半杯水都不渗!这张纸凭什么" }, { title: "桌上一杯水倒了三天" }],
      get,
      { title: "千万别被这张纸骗了" },
      "zh"
    );
    expect(out.map((v) => v.title)).toEqual(["半杯水都不渗,这张纸凭什么", "桌上一杯水倒了三天"]);
  });

  it("角度撞车的丢掉(与原版或已保留的兄弟)", () => {
    const out = filterDuplicatePackagings(
      [{ title: "搬箱子别再弯腰", angle: "pain" as const }, { title: "三分钟测完这张纸", angle: "question" as const }],
      get,
      { title: "原标题", angle: "pain" as const },
      "zh"
    );
    expect(out.map((v) => v.title)).toEqual(["三分钟测完这张纸"]);
  });

  it("空标题丢掉", () => {
    expect(filterDuplicatePackagings([{ title: "  " }, { title: "真的不同" }], get, { title: "原标题" }, "zh")).toHaveLength(1);
  });
});

/**
 * 出处检查(ungroundedSpans):改标题最容易「补一个片段里没有的锚点」,那种
 * 标题最像爆款却兑现不了。数字与引文是唯一可机器核对的锚点,只查这两类。
 */
describe("ungroundedSpans", () => {
  const CLIP = "Mahkeme 50 bin lira ceza istedi. Bunu kimse söylemiyor ama kasanın anahtarı onda.";

  it("片段里有的数字/引文放行(千分位、小数点差异不算改数)", () => {
    expect(ungroundedSpans("50 bin liralık dava", CLIP, "tr")).toEqual([]);
    // 「50.000」与「50000」按同一个数比较(千分位只是写法)。
    expect(ungroundedSpans("Mahkeme 50.000 lira istedi", "Mahkeme 50000 lira istedi", "tr")).toEqual([]);
    // 但 50 与 500 是两个数,不能因为前缀相同就放行。
    expect(ungroundedSpans("500 bin lira", "50 bin lira", "tr")).toEqual(["500"]);
    expect(ungroundedSpans("7,5 sene sonra", "7.5 sene önce", "tr")).toEqual([]);
    expect(ungroundedSpans("«kasanın anahtarı onda» diyor", CLIP, "tr")).toEqual([]);
  });

  it("凭空出现的数字/引文被点名(引文按语言折叠)", () => {
    expect(ungroundedSpans("500 bin liralık vantilatör", CLIP, "tr")).toEqual(["500"]);
    expect(ungroundedSpans("「Kasanın anahtarı bende」 dedi", CLIP, "tr")).toEqual(["Kasanın anahtarı bende"]);
  });

  it("没有数字/引文的标题永远有出处", () => {
    expect(ungroundedSpans("Hırsıza hırsız dedim, mahkemeye çıktık", CLIP, "tr")).toEqual([]);
    expect(ungroundedSpans("", CLIP, "tr")).toEqual([]);
  });
});
