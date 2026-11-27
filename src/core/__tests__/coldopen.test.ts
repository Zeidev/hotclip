import { describe, it, expect } from "vitest";
import {
  planColdOpen,
  planFlashForward,
  flashWindow,
  coldOpenQuoteText,
  COLD_OPEN_MAX_SEC,
  COLD_OPEN_MIN_SEC,
  FLASH_LEAD_SEC,
  FLASH_TAIL_SEC,
  FLASH_MAX_SEC,
} from "../coldopen";
import { parseSelections } from "../highlight/detect";
import type { TranscriptWord } from "../../shared/api-types";

/** 每字 0.5s 的等宽词流,从 startSec 起。 */
function words(text: string, startSec: number, perChar = 0.5): TranscriptWord[] {
  return Array.from(text).map((ch, i) => ({
    text: ch,
    startSec: startSec + i * perChar,
    endSec: startSec + (i + 1) * perChar,
  }));
}

/** 真实时间轴上的一个词(实测素材的时间戳)。 */
function at(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

describe("planColdOpen", () => {
  // 切片 100s 起,前 12s 是铺垫,钩子句「直接倒半杯水都不带渗」在 112s 起
  const clipStart = 100;
  const clipWords = [...words("今天给大家带来一款超级好用的纸巾三层加厚", clipStart), ...words("直接倒半杯水都不带渗", 112)];

  it("定位钩子句并返回其词边界区间(10 字×0.5s=5s,超 MAX=4s 截到 116s)", () => {
    const p = planColdOpen(clipWords, "直接倒半杯水都不带渗", clipStart);
    expect(p).not.toBeNull();
    expect(p!.startSec).toBeCloseTo(112, 3);
    expect(p!.endSec).toBeCloseTo(116, 3);
  });

  it("钩子句超长:从句首截到 MAX 并收口到词尾", () => {
    const p = planColdOpen(clipWords, "直接倒半杯水都不带渗", clipStart)!;
    expect(p.endSec - p.startSec).toBeLessThanOrEqual(COLD_OPEN_MAX_SEC + 1e-6);
    // 词边界收口:endSec 必须等于某个词的 endSec
    expect(clipWords.some((w) => Math.abs(w.endSec - p.endSec) < 1e-6)).toBe(true);
  });

  it("钩子离切片开头太近(<10s)→ 跳过", () => {
    const near = [...words("开场白", 100), ...words("爆点句在这里", 103), ...words("后续内容继续说", 108)];
    expect(planColdOpen(near, "爆点句在这里", 100)).toBeNull();
  });

  it("钩子就是切片自己的开场句 → 跳过(实测 162 条候选里 146 条如此)", () => {
    // 实测样例(项目 6ac65113 一类的真实素材):切片从句首开剪,钩子句逐字落在首词上
    // (首词延迟 0.00s)。前置等于把开场句连着重播,所以必须返回 null——这是这条路径
    // 在真实素材上的常态,不是异常。
    const opening = [
      at("ilginç", 100.0, 100.4),
      at("bir", 100.4, 100.6),
      at("gün", 100.6, 101.0),
      at("ilginç", 101.0, 101.4),
      at("çok", 101.4, 101.7),
      at("ilginç", 101.7, 102.1),
      at("ben", 102.4, 102.7),
      at("bugün", 102.7, 103.2),
    ];
    expect(planColdOpen(opening, "ilginç bir gün ilginç çok ilginç", 100)).toBeNull();
  });

  it("钩子落在切片中段但仍在 SKIP 窗内(实测 7.6s)→ 仍跳过(重复间隔太近)", () => {
    // 实测样例(项目 59242a58 #7):切片 1392.8s 起,开场是另一段铺垫,钩子句
    // 「ilk gün beni ban'lasana」在 1400.4s(离切片开头 7.6s)。前置后这句会在 7.6 秒后
    // 原样重播,按常量注释里的通行口径(重复间隔 <10-15s 太机械)照样跳过。
    // 这是本路径唯一可能真出片的一类候选;要把阈值放到 3 秒以内才会放行——那时先删掉
    // 这条测试,把重复间隔的取舍当成一个明确的产品决定。
    const late = [
      at("lan", 1392.8, 1393.1),
      at("oğlum", 1393.1, 1393.6),
      at("ben", 1393.6, 1393.9),
      at("beş", 1393.9, 1394.3),
      at("gün", 1394.3, 1394.7),
      at("oynadım", 1394.7, 1395.3),
      at("ilk", 1400.4, 1400.8),
      at("gün", 1400.8, 1401.2),
      at("beni", 1401.2, 1401.6),
      at("ban'lasana", 1401.6, 1402.2),
      at("kes", 1402.3, 1402.6),
    ];
    expect(planColdOpen(late, "ilk gün beni ban'lasana", 1392.8)).toBeNull();
  });

  it("同一句在开头也出现过:前置中段那次,不把合法候选当开场丢掉", () => {
    const hook = "直接倒半杯水都不带渗";
    const repeat = [
      ...words(hook, 101), // 101s:已经是开场,这次重复没意义
      ...words("然后我们看看这个纸的厚度", 107),
      ...words(hook, 120), // 120s:中段这次才是全片最炸的钩子句
    ];
    const p = planColdOpen(repeat, hook, 100);
    expect(p).not.toBeNull();
    expect(p!.startSec).toBeCloseTo(120, 3);
    expect(p!.endSec - p!.startSec).toBeLessThanOrEqual(COLD_OPEN_MAX_SEC + 1e-6);
  });

  it("两次都在窗口内 → 仍然跳过(词跨窗口边界命中按太近处理)", () => {
    const hook = "直接倒半杯水都不带渗";
    const allNear = [...words(hook, 101), ...words("补一句", 106.5), ...words(hook, 108)];
    expect(planColdOpen(allNear, hook, 100)).toBeNull();
  });

  it("中段那次短于 MIN(1s)→ 不前置", () => {
    const hook = "直接倒半杯水都不带渗";
    const quick = [...words(hook, 101), ...words("中间内容", 107), ...words(hook, 120, 0.08)];
    expect(planColdOpen(quick, hook, 100)).toBeNull();
  });

  it("钩子定位失败/空钩子/过短片段 → null(宁可不做不可做错)", () => {
    expect(planColdOpen(clipWords, "转写里根本没有这句", clipStart)).toBeNull();
    expect(planColdOpen(clipWords, "", clipStart)).toBeNull();
    expect(planColdOpen([], "直接倒", clipStart)).toBeNull();
    // 命中但只有一个字(0.5s < MIN=1s)
    const tiny = [...words("很长的铺垫内容一直在说话不停地说", 100), ...words("炸", 115)];
    expect(planColdOpen(tiny, "炸", 100)).toBeNull();
    expect(COLD_OPEN_MIN_SEC).toBeGreaterThan(0.5);
  });

  it("引用与转写标点/大小写有出入仍能对齐(同选段的归一化匹配)", () => {
    const p = planColdOpen(clipWords, "直接倒半杯水,都不带渗!", clipStart);
    expect(p).not.toBeNull();
    expect(p!.startSec).toBeCloseTo(112, 3);
  });
});

describe("planFlashForward / flashWindow(爆点闪现窗)", () => {
  const seg = { startSec: 100, endSec: 130 };

  it("没有词流时退回下限窗(lead+tail)", () => {
    const p = planFlashForward([106.93], [seg])!;
    expect(p.startSec).toBeCloseTo(106.93 - FLASH_LEAD_SEC, 5);
    expect(p.endSec).toBeCloseTo(106.93 + FLASH_TAIL_SEC, 5);
  });

  it("有词流时吸附到词边界并扩到整句(旧实现只截到「…anlatsam」这种半句话)", () => {
    // 用户素材实测:峰值 106.93,原来 0.7s 的窗只盖住 anlatsam/inanmaz 两个词
    const track = [
      at("ya", 106.02, 106.13),
      at("anlatsam", 106.87, 107.33),
      at("inanmaz", 107.33, 107.73),
      at("kimse", 107.73, 108.02),
      at("ya", 108.02, 108.13),
      at("canlı", 108.37, 108.63),
      at("yayın", 108.63, 109.03),
      at("yapmasam", 109.03, 109.87),
    ];
    const p = planFlashForward([106.93], [seg], track)!;
    expect(p.startSec).toBeCloseTo(106.87, 3); // 句首(106.02 的 ya 隔着 0.74s 静音,不算同句)
    expect(p.endSec).toBeCloseTo(109.87, 3); // 整句,3.0s = 上限
    expect(p.endSec - p.startSec).toBeLessThanOrEqual(FLASH_MAX_SEC + 1e-6);
    expect(track.some((w) => w.endSec === p.endSec)).toBe(true); // 收口在词尾
  });

  it("句子比上限短时整句照收(不硬凑到上限)", () => {
    const track = [
      at("ban'ladılar", 104.48, 105.23),
      at("açıcaz", 106.3, 106.72),
      at("dediler", 106.72, 107.2),
      at("üç", 107.2, 107.34),
      at("gün", 107.34, 107.55),
      at("beni", 107.55, 107.83),
      at("geciktirdiler", 107.83, 108.73),
    ];
    const p = planFlashForward([106.33], [seg], track)!;
    expect(p.startSec).toBeCloseTo(106.3, 3);
    expect(p.endSec).toBeCloseTo(108.73, 3);
  });

  it("峰值在无人声处(笑声/掌声)时不做词吸附,给下限窗", () => {
    const track = [at("前面有人说话", 100.0, 101.0), at("后面也有人说话", 120.0, 121.0)];
    const p = planFlashForward([106.93], [seg], track)!;
    expect(p).toEqual({ startSec: 106.93 - FLASH_LEAD_SEC, endSec: 106.93 + FLASH_TAIL_SEC });
  });

  it("跨段边界的词不参与吸附:窗绝不越出本保留段", () => {
    // 99.5-100.4 这个词在段外起步,跳剪剪掉的部分不能被引子带回来
    const track = [at("跨界的词", 99.5, 100.4), at("段内的一句", 105.0, 105.8)];
    const p = flashWindow(100.3, seg, track);
    expect(p.startSec).toBe(100); // 夹在段首,而不是 99.5
  });

  it("扩窗不跨过被剪掉的空隙:只在本段内收口", () => {
    const cut = [
      { startSec: 100, endSec: 107 },
      { startSec: 110, endSec: 120 },
    ];
    const track = [at("段内前半句", 104.6, 105.5), at("段内后半句", 105.8, 106.9), at("剪掉那段的词", 110.2, 111.0)];
    const p = planFlashForward([106.5], cut, track)!;
    expect(p.startSec).toBeCloseTo(104.6, 3);
    expect(p.endSec).toBeCloseTo(106.9, 3);
    expect(p.endSec).toBeLessThanOrEqual(107);
  });

  it("峰值不在任何保留段(落在空隙)→ 换下一个峰", () => {
    const cut = [
      { startSec: 100, endSec: 104 },
      { startSec: 108, endSec: 112 },
    ];
    const p = planFlashForward([106, 110], cut, [at("段内", 110.0, 110.9)])!;
    expect(p.startSec).toBeCloseTo(110.0, 3);
  });

  // 真实素材上量出来的三件事:单块峰值分不开谁更好(0.536-0.566)、
  // 33ms 的尖峰能和 2.5 秒的大笑并列、按 ±lead/tail 取窗会漏掉整段爆发
  it("按持续能量挑,不按候选给的顺序(尖峰排前面也抢不走好那一刻)", () => {
    const spark = { srcSec: 106, score: 0.06, startSec: 105.9, endSec: 106.0 }; // 33ms
    const laugh = { srcSec: 118, score: 0.9, startSec: 116.9, endSec: 119.4 }; // 2.5s 爆发
    const p = planFlashForward([spark, laugh], [seg])!;
    expect(p.startSec).toBeGreaterThan(115); // 闪的是大笑,不是尖峰
  });

  it("近等候选(分差在 15% 内)挑成片里更靠后的:闪现要剧透结局,不是再演一遍开头", () => {
    const early = { srcSec: 105, score: 0.5 };
    const late = { srcSec: 120, score: 0.46 }; // 0.46 ≥ 0.85 × 0.5
    expect(planFlashForward([early, late], [seg])!.startSec).toBeGreaterThan(115);
    // 差得够多时仍然选能量高的那个(位置偏好不能盖过真实差距)
    const weakerLate = { srcSec: 120, score: 0.2 };
    expect(planFlashForward([early, weakerLate], [seg])!.startSec).toBeLessThan(110);
  });

  it("事件的响区间决定下限窗:整段爆发从头到尾,超上限就砍引子留余韵", () => {
    const burst = { srcSec: 106, score: 1, startSec: 105.5, endSec: 107.5 };
    const win = planFlashForward([burst], [seg])!;
    expect(win.endSec).toBeCloseTo(107.5 + FLASH_TAIL_SEC, 5);
    expect(win.startSec).toBeCloseTo(win.endSec - FLASH_MAX_SEC, 5); // 4.75s 的窗收到 3s
  });

  it("吸附到词边界后也不许超上限(实测 3.34s),从头部整词丢、保住爆点", () => {
    const words = [at("a", 104.5, 104.9), at("b", 105.0, 105.9), at("c", 106.0, 106.9), at("d", 107.0, 108.3)];
    const p = planFlashForward([{ srcSec: 106.0, score: 1, startSec: 105.2, endSec: 107.0 }], [seg], words)!;
    expect(p.endSec - p.startSec).toBeLessThanOrEqual(FLASH_MAX_SEC + 1e-6);
    expect(p.startSec).toBeCloseTo(106.0, 3); // 丢到「c」为止,b 的尾巴不带进来
    expect(p.endSec).toBeCloseTo(108.3, 3);
  });
});

// coldOpenQuote(选段输出里「片段中段最炸、但不在开头」的一句)出现在 2026-11:
// 转写模式的 hook 按提示词定义就是片段首句(见 highlight/prompt.ts 的字段说明),
// 拿它当前置预览只会撞上 near-start 守卫,所以另开一条可选字段。下面钉住
// 「字段缺席 = 旧行为逐字不变」和「字段有值 = 真正前置中段那句」两端。
describe("coldOpenQuote(cold-open 预览句的选择与回退)", () => {
  const clipStart = 100;
  const clipWords = [
    ...words("今天给大家带来一款超级好用的纸巾", 100), // 15 字 ≈ 7.5s 铺垫
    ...words("直接倒半杯水都不带渗", 120), // 中段爆句
  ];

  it("字段缺席/空白 → 退回 hook,与加字段之前逐字同一条字符串", () => {
    expect(coldOpenQuoteText({ hook: "直接倒半杯水都不带渗" })).toBe("直接倒半杯水都不带渗");
    expect(coldOpenQuoteText({ hook: "直接倒半杯水都不带渗", coldOpenQuote: "   " })).toBe(
      "直接倒半杯水都不带渗"
    );
    expect(coldOpenQuoteText({})).toBeUndefined();
    expect(coldOpenQuoteText(undefined)).toBeUndefined();
    // 回退后的输入与旧调用点完全一致 → planColdOpen 结果也必须一致(空 hook → null)
    expect(planColdOpen(clipWords, coldOpenQuoteText({ hook: "  " }) ?? "", clipStart)).toBeNull();
  });

  it("字段有值 → 优先用它,前置的是中段那句而不是首句", () => {
    const meta = {
      hook: "今天给大家带来一款超级好用的纸巾", // 片段首句(按旧语义拿它前置必被守卫拒掉)
      coldOpenQuote: "直接倒半杯水都不带渗",
    };
    expect(coldOpenQuoteText(meta)).toBe("直接倒半杯水都不带渗");
    const p = planColdOpen(clipWords, coldOpenQuoteText(meta)!, clipStart);
    expect(p).not.toBeNull();
    expect(p!.startSec).toBeCloseTo(120, 3);
  });

  it("字段给的就是开头句 → near-start 守卫照旧拒绝(新字段不能绕过产品决定)", () => {
    const meta = {
      hook: "今天给大家带来一款超级好用的纸巾",
      coldOpenQuote: "今天给大家带来一款超级好用的纸巾",
    };
    expect(planColdOpen(clipWords, coldOpenQuoteText(meta)!, clipStart)).toBeNull();
  });

  it("hook 是画面描述(moment 通道)、无新字段 → 匹配不到 → null,与今天一致", () => {
    const visual = { hook: "Şüpheli bakış, 'you sure' diyaloğu." };
    expect(planColdOpen(clipWords, coldOpenQuoteText(visual)!, clipStart)).toBeNull();
  });
});

describe("parseSelections:coldOpenQuote 解析", () => {
  const base = {
    title: "t",
    hook: "h",
    score: 80,
    reason: "r",
    startSegmentId: 1,
    endSegmentId: 2,
    quoteStart: "a",
    quoteEnd: "b",
    keywords: [],
  };
  const parse = (clip: Record<string, unknown>) => parseSelections(JSON.stringify({ clips: [clip] }))[0];

  it("新字段原样带进 RawSelection", () => {
    expect(parse({ ...base, coldOpenQuote: "中段那句" }).coldOpenQuote).toBe("中段那句");
  });
  it("缺省或空白 → undefined(下游走 hook 回退)", () => {
    expect(parse(base).coldOpenQuote).toBeUndefined();
    expect(parse({ ...base, coldOpenQuote: "   " }).coldOpenQuote).toBeUndefined();
    expect(parse({ ...base, coldOpenQuote: null }).coldOpenQuote).toBeUndefined();
  });
});
