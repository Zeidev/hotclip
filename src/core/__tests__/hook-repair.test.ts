/**
 * Başlık/kanca onarımı(v0.38):yerel güç kapısı + inceleme turunun düzeltmesi.
 *
 * Fikstürlerin hepsi gerçek bir projeden geldi (`Yayın kaydı 24.11 - Cenkbey`);
 * testin işi "sistem gerçekten zayıf olanı yakalıyor mu" sorusunu cevaplamak.
 * Kuralın özü: güç kodları **sinyal**, veto değil — kötü bir başlığı yanlışlıkla
 * reddetmek, üç kötü başlığı kaçırmaktan daha pahalı.
 */
import { describe, it, expect } from "vitest";
import {
  checkHookQuality,
  needsHookRepair,
  needsTitleRepair,
  quoteKey,
  weaknessCount,
  type HookWarnCode,
} from "../hook-quality";
import { hookCraftSection } from "../hook-craft";
import { buildReviewPrompt } from "../highlight/prompt";
import { parseReviews, applyReviews } from "../highlight/detect";
import type { Transcript } from "../transcribe/types";

const tr = { lang: "tr" as const };
const codes = (title: string): HookWarnCode[] =>
  checkHookQuality([{ id: 1, title }], { ...tr, surface: "stage1" })[0]?.codes ?? [];
const hookCodes = (hook: string): HookWarnCode[] =>
  checkHookQuality([{ id: 1, title: "x", hook }], { ...tr, surface: "stage1Hook" })[0]?.codes ?? [];

describe("stage-1 başlık gücü: gerçek veriden", () => {
  it("konu etiketi + çapasız soru yakalanır ve onarıma gider", () => {
    const c = codes("Odada havalandırma var mı");
    expect(c).toContain("no-anchor");
    expect(c).toContain("topic-label");
    expect(needsTitleRepair(c)).toBe(true);
  });

  it("tek başına çapasızlık onarım istemez(片inin gerçekten sayısı olmayabilir)", () => {
    const c = codes("Kumara başladım");
    expect(c).toEqual(["no-anchor"]);
    expect(needsTitleRepair(c)).toBe(false);
  });

  it("反转/对照转折本身就是锚点:'bitmiyor' başlığı artık çapasız sayılmaz", () => {
    // 27/40 gerçek başlık yalnız no-anchor'la işaretlenmişti; çoğu bu yapıdaydı
    expect(codes("Parayla bitmiyor, altyapı lazım")).toEqual([]);
    // İngilizce karşıtlık ve negasyon da aynı işi yapar
    expect(
      checkHookQuality([{ id: 1, title: "Money wasn't the problem" }], { lang: "en", surface: "stage1" })[0]?.codes ?? []
    ).toEqual([]);
  });

  it("iyi başlıklar geçer: sayı, sayı sözcüğü, geçmiş zaman", () => {
    expect(codes("7,5 sene önce kumarhanede kağıdımı attırdım")).toEqual([]);
    expect(codes("Milyon harcadığım karakteri pak diye banladılar")).toEqual([]);
  });

  it("nötr süreç tarifi ayrı kod alır", () => {
    expect(codes("15 telefonla geziyorum, hiçbiri tutmuyor")).toContain("flat-close");
  });

  it("güç kodları publish/变体 yüzeylerine sızmaz(返工 maliyeti tetiklenmesin)", () => {
    const out = checkHookQuality([{ id: 1, title: "Odada havalandırma var mı" }], {
      ...tr,
      surface: "publish",
    });
    expect(out).toEqual([]);
  });
});

describe("stage-1 开场句(引文)kapısı: gerçek veriden", () => {
  it("dolgu sözcükle başlayan açılış yakalanır", () => {
    expect(hookCodes("Bak abi kumara.")).toContain("hook-filler-open");
    expect(hookCodes("Şimdi sektördeki birçok insan PVP")).toContain("hook-filler-open");
    expect(hookCodes("Kardeşim 15 tane telefonla geziyorum.")).toContain("hook-filler-open");
  });

  it("tamamı dolgu olan açılış interjection sayılır", () => {
    const c = hookCodes("Vallahi billahi.");
    expect(c).toContain("hook-interjection");
    expect(needsHookRepair(c)).toBe(true);
  });

  it("küçük harfle başlayan yarım açılış fragment sayılır", () => {
    const c = hookCodes("bi kardeşiniz var");
    expect(c).toContain("hook-fragment");
    expect(needsHookRepair(c)).toBe(true);
  });

  it("tam bir cümle geçer", () => {
    expect(hookCodes("Kumarı bıraktım, her şeyimi kaybettim.")).toEqual([]);
    expect(hookCodes("Ben de bir ara gerçekten kumara karşı")).toEqual([]);
  });

  it("açılış uzunluk üst sınırı normal bir cümleyi yakmaz", () => {
    const long = "Ya bu arada hırsıza hırsız dediğim için bana hakaret davası açmış, mahkemeye gidiyoruz";
    expect(hookCodes(long)).not.toContain("too-long");
  });
});

describe("quoteKey / doktrin", () => {
  it("quoteKey sadece noktalama/büyük-küçük farkını tolere eder", () => {
    expect(quoteKey("Bunu kimse söylemiyor, ama...", "tr")).toBe("bunu kimse söylemiyor ama");
  });

  it("doktrin üç dilde yasak şekilleri ve çapa+dönüş şartını taşır", () => {
    expect(hookCraftSection("tr")).toContain("Yasak şekiller");
    expect(hookCraftSection("tr")).toContain("çapa");
    expect(hookCraftSection("tr")).toContain("dönüş");
    expect(hookCraftSection("en")).toContain("Banned shapes");
    expect(hookCraftSection("en")).toContain("anchor");
    expect(hookCraftSection("zh")).toContain("禁止的句形");
    expect(hookCraftSection("zh")).toContain("锚点");
  });
});

describe("inceleme turu: yerel kapı notu + hookFix", () => {
  const tx: Transcript = {
    language: "tr",
    engine: "test",
    durationSec: 10,
    segments: [
      {
        id: 1,
        startSec: 0,
        endSec: 4,
        text: "Ya bu arada hırsıza hırsız dediğim için bana hakaret davası açmış.",
        words: [],
      },
      {
        id: 2,
        startSec: 4.5,
        endSec: 9,
        text: "Bunu kimse söylemiyor ama gerçek şu ki kasanın anahtarı onda.",
        words: [],
      },
    ],
  };

  it("zayıf başlık ve kanca bloğa not olarak düşer", () => {
    const p = buildReviewPrompt(
      tx,
      [
        {
          id: 1,
          title: "Odada havalandırma var mı",
          hook: "Vallahi billahi.",
          startSec: 0,
          endSec: 4,
          text: tx.segments[0].text,
        },
      ],
      "tr"
    );
    expect(p).toContain("açılış=hook-filler-open,hook-interjection");
  });

  it("temiz adaya not eklenmez", () => {
    const p = buildReviewPrompt(
      tx,
      [{ id: 1, title: "7,5 sene önce kumarhanede kağıdımı attırdım", hook: "Bunu kimse söylemiyor ama gerçek şu ki kasanın anahtarı onda.", startSec: 4.5, endSec: 9, text: tx.segments[1].text }],
      "tr"
    );
    expect(p).toContain("Yerel kapı");
    expect(p).not.toContain("Yerel kapı:");
    expect(p).not.toContain("başlık=");
    expect(p).not.toContain("açılış=");
  });

  it("çıktı şeması hookFix alanını ister ve parse eder", () => {
    const p = buildReviewPrompt(tx, [{ id: 1, title: "x", startSec: 0, endSec: 4, text: tx.segments[0].text }], "tr");
    expect(p).toContain('"hookFix"');
    const out = parseReviews('{"reviews":[{"id":1,"verdict":"publish","hookFix":"Bunu kimse söylemiyor ama gerçek şu ki"}]}');
    expect(out[0].hookFix).toBe("Bunu kimse söylemiyor ama gerçek şu ki");
  });
});

describe("applyReviews: onarımı kabul etme kuralları", () => {
  const base = {
    id: 1,
    startSec: 0,
    endSec: 9,
    text: "Ya bu arada hırsıza hırsız dediğim için bana hakaret davası açmış. Bunu kimse söylemiyor ama gerçek şu ki kasanın anahtarı onda.",
    title: "Hırsıza hırsız dedim, dava açtı",
    hook: "Ya bu arada hırsıza hırsız dediğim için",
    reason: "",
    boundary: "exact" as const,
    keywords: [],
    recommended: true,
    reviewNote: "",
  };

  it("片段te birebir duran daha güçlü kanca kabul edilir", () => {
    const out = applyReviews(
      [{ ...base, score: 90 }],
      [
        {
          id: 1,
          keep: true,
          gate: "publish",
          score: 90,
          note: "",
          hookFix: "Bunu kimse söylemiyor ama gerçek şu ki kasanın anahtarı onda.",
        },
      ],
      "tr"
    );
    expect(out[0].hook).toBe("Bunu kimse söylemiyor ama gerçek şu ki kasanın anahtarı onda.");
  });

  it("daha kısa ama yine zayıf kanca kabul edilmez(bağlaçla biten cümle)", () => {
    const out = applyReviews(
      [{ ...base, score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", hookFix: "Bunu kimse söylemiyor ama gerçek şu ki" }],
      "tr"
    );
    expect(out[0].hook).toBe(base.hook);
  });

  it("片段te olmayan(uydurulmuş)kanca reddedilir", () => {
    const out = applyReviews(
      [{ ...base, score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", hookFix: "Hırsızlar beni mahvetti" }],
      "tr"
    );
    expect(out[0].hook).toBe(base.hook);
  });

  it("daha zayıf kanca reddedilir", () => {
    const out = applyReviews(
      [{ ...base, score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", hookFix: "Ya bu arada" }],
      "tr"
    );
    expect(out[0].hook).toBe(base.hook);
  });

  it("çapa kazandıran başlık düzeltmesi kabul edilir", () => {
    const out = applyReviews(
      [{ ...base, text: `${base.text} Mahkeme 50 bin lira ceza istedi.`, title: "Odada havalandırma var mı", score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", titleFix: "50 bin liralık vantilatör odada ne yapıyor" }],
      "tr"
    );
    expect(out[0].title).toBe("50 bin liralık vantilatör odada ne yapıyor");
  });

  it("片段te bulunmayan sayı/引文 taşıyan başlık düzeltmesi reddedilir(出处检查)", () => {
    // 模型最爱的「补一个不存在的锚点」:片段里没有 50 bin,却写成最像爆款的标题。
    const invented = applyReviews(
      [{ ...base, title: "Odada havalandırma var mı", score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", titleFix: "50 bin liralık vantilatör odada ne yapıyor" }],
      "tr"
    );
    expect(invented[0].title).toBe("Odada havalandırma var mı");
    // 数字容千分位/小数点差异:片段里是 7.5,标题写 7,5 仍算有出处。
    const separators = applyReviews(
      [{ ...base, text: `${base.text} 7.5 sene sonra`, title: "Odada havalandırma var mı", score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", titleFix: "7,5 sene sonra mahkemeye çıktım" }],
      "tr"
    );
    expect(separators[0].title).toBe("7,5 sene sonra mahkemeye çıktım");
    // 引文同样要在片段里逐字存在。
    const quoted = applyReviews(
      [{ ...base, title: "Odada havalandırma var mı", score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", titleFix: "「Kasanın anahtarı bende」 dedi" }],
      "tr"
    );
    expect(quoted[0].title).toBe("Odada havalandırma var mı");
  });

  it("弱lendirmeyen başlık düzeltmesi reddedilir", () => {
    const out = applyReviews(
      [{ ...base, title: "Parayla bitmiyor, altyapı lazım", score: 90 }],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", titleFix: "Sunucu açmak parayla bitmiyor" }],
      "tr"
    );
    expect(out[0].title).toBe("Parayla bitmiyor, altyapı lazım");
  });

  it("eski davranış korunur: kalıp sözle başlayan başlık düzeltilir", () => {
    const out = applyReviews(
      [
        {
          ...base,
          text: `${base.text} 7,5 sene önce kumarhanede kağıdımı attırdım.`,
          title: "Merhaba arkadaşlar bugün sizlere kumardan",
          score: 90,
        },
      ],
      [{ id: 1, keep: true, gate: "publish", score: 90, note: "", titleFix: "7,5 sene önce kumarhanede kağıdımı attırdım" }],
      "tr"
    );
    expect(out[0].title).toBe("7,5 sene önce kumarhanede kağıdımı attırdım");
  });

  it("weaknessCount yalnız güç kodlarını sayar", () => {
    expect(weaknessCount(["no-anchor", "topic-label", "too-long"])).toBe(2);
  });
});