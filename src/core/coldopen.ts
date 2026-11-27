/**
 * 高潮前置(cold-open):把切片内最炸的钩子句剪成迷你片拼到开头,再接完整
 * 正片(播到原位置时原样重复——综艺/切片圈通行手法)。前 3 秒抓不住人就
 * 划走,这是短视频完播率的命门;商业工具把 AI Hook 锁在付费档。
 * 本模块只做纯决策(钩子句定位+取舍),拼接由导出层用 concatClips 完成。
 *
 * 两种迷你片:
 *  - planColdOpen:钩子**句**前置(1-4s,靠转写反查,信息型钩子)
 *  - planFlashForward:爆点**画面**闪现(下限 0.3s、上限 3s,靠响度峰值事件
 *    定位后按词边界扩到整句,视觉型钩子)——2026 调研:全网仅 0.04% 切片有
 *    visual hook,flash-forward(闪现结局再切回开头)是被人类工艺与开源实现
 *    互证的空白手法。
 */
import type { TranscriptWord } from "../shared/api-types";
import { buildTokenIndex, matchQuote } from "./highlight/match";

export interface ColdOpenPlan {
  startSec: number;
  endSec: number;
}

/** 迷你片太短观众接收不到信息(通行下限约 1 秒/半句话)。 */
export const COLD_OPEN_MIN_SEC = 1;
/** 超过 3-4 秒还没进正片就开始掉人(OpusClip 方法论:2-2.5 秒内交付完毕)。 */
export const COLD_OPEN_MAX_SEC = 4;
/**
 * 爆点距开头太近时再前置一遍显得机械重复,通行建议 <10-15 秒就跳过。
 *
 * 实测(本机 13 个项目 / 162 条真实候选):153 条钩子能在词流里定位,其中 149 条
 * 命中在切片开头 1 秒内(146 条逐字就是切片首句,首词延迟 0.00s),只有 4 条落在
 * 1-8 秒。原因是转写稿模式的选段提示词要求「钩子原文 = 切片的开场句」(见
 * highlight/prompt.ts),切片本身就从句首开剪——此时前置等于把开场句连着重播。
 * 所以拿 hook 当前置素材等于把开场句连着重播(守卫拒掉是对的);前置素材改从
 * coldOpenQuote 取(见下),hook 只在它缺席时兜底——那时这条路径基本只在提示词被
 * 违反时才会触发,闪现冷开场(planFlashForward)才是主力。两条实测样例钉在
 * __tests__/coldopen.test.ts 里。
 */
export const COLD_OPEN_SKIP_NEAR_START_SEC = 10;

/**
 * 前置迷你片用哪段文字(纯函数):
 * - 选段输出里明确标了 coldOpenQuote(「片段中段最炸、但不在开头的一句」)就用它;
 *   这条字段存在的理由:转写模式的 hook 按提示词定义就是**片段首句**,
 *   拿它当前置预览等于把开场句重播一遍(planColdOpen 的 near-start 守卫会拒掉)。
 * - 字段缺席/空白 → 退回 hook,与加这个字段之前**逐字一致**(旧项目文件、
 *   moment 通道的视觉描述都走这条)。
 */
export function coldOpenQuoteText(meta?: {
  hook?: string;
  coldOpenQuote?: string;
}): string | undefined {
  return (meta?.coldOpenQuote ?? "").trim() || (meta?.hook ?? "").trim() || undefined;
}

/**
 * 决定这条切片的 cold-open 片段:在切片词流里反查钩子句(与选段同一套
 * 引用对齐),不满足任一条件返回 null(前置是锦上添花,宁可不做不可做错):
 * - 钩子句定位失败(LLM 引用偶尔与转写有出入)
 * - 钩子句离切片开头太近(已经是开场,重复没意义)
 * - 片段过短;过长则截到 MAX(按词边界收口)
 */
export function planColdOpen(
  clipWords: TranscriptWord[],
  hookText: string,
  clipStartSec: number
): ColdOpenPlan | null {
  const hook = (hookText ?? "").trim();
  if (!hook || clipWords.length === 0) return null;
  const index = buildTokenIndex(clipWords);
  let m = matchQuote(index, hook, hook);
  if (m && m.startSec - clipStartSec < COLD_OPEN_SKIP_NEAR_START_SEC) {
    // 同一句话在开头也出现过(转写复读/口头禅)时,第一次命中的是开场那次——
    // 那次确实「重复没意义」,但中段这次仍是全片最炸的钩子句:从窗口外再
    // 找一次,别把合法候选白白丢掉。词跨窗口边界命中时按仍然太近处理。
    m = matchQuote(index, hook, hook, clipStartSec + COLD_OPEN_SKIP_NEAR_START_SEC);
    if (m && m.startSec - clipStartSec < COLD_OPEN_SKIP_NEAR_START_SEC) m = null;
  }
  if (!m) return null;

  let endSec = m.endSec;
  if (endSec - m.startSec > COLD_OPEN_MAX_SEC) {
    // 从句首起截 MAX 秒,收口到不超界的最后一个词尾(卡拉OK不切半个词)
    const cap = m.startSec + COLD_OPEN_MAX_SEC;
    let snapped = m.startSec;
    for (const w of clipWords) {
      if (w.startSec >= m.startSec - 1e-3 && w.endSec <= cap + 1e-3) snapped = Math.max(snapped, w.endSec);
    }
    endSec = snapped;
  }
  if (endSec - m.startSec < COLD_OPEN_MIN_SEC) return null;
  return { startSec: m.startSec, endSec };
}

/** 闪现片段:峰值前带一点铺垫帧、峰值后留一点余韵(下限,实际按词边界扩,见 flashWindow)。 */
export const FLASH_LEAD_SEC = 0.35;
export const FLASH_TAIL_SEC = 0.8;
/**
 * 闪现最长期限。旧实现只有 0.2+0.5=0.7 秒,真实素材上量出来只截到半句话
 * (「…anlatsam」),信息量为零——观众看不懂发生了什么,冷开场就成了噪声。
 * 引子要能说清一件事,但也不能长到像正片已经开始。
 */
export const FLASH_MAX_SEC = 3;
/** 词间静音超过此值算句读:扩窗不跨过它(否则把前后两句无关的话粘一起)。 */
export const FLASH_UTTERANCE_GAP_SEC = 0.45;
/** 短于此的闪现观众根本看不清(调研口径 0.3-1s,取下限做门槛)。 */
export const FLASH_MIN_SEC = 0.3;
/** 爆点在成片输出时间上离开头太近就不闪——马上就要看到了,闪现即剧透。 */
export const FLASH_SKIP_NEAR_START_SEC = 6;

/**
 * 一个闪现候选:峰值事件的完整描述(见 audio-peaks 的 mapPeakMoments)。
 * 光给一个时刻也能用(旧测试/旧调用),但那样只能按 ±lead/tail 取窗,
 * 也给不出「谁更值得闪」的排序。
 */
export interface FlashCandidate {
  /** 峰值事件的中心(源片绝对时间)。 */
  srcSec: number;
  /** 该事件在成片输出时间轴上的位置——「闪结局」偏好和剧透守卫用它。 */
  outSec?: number;
  /** 持续能量分(越响越久越高)。 */
  score?: number;
  /** 事件的连续响区间(源片绝对时间):有它时窗盖整段爆发,不是纯 ±lead/tail。 */
  startSec?: number;
  endSec?: number;
}

/**
 * 近等候选算同一档:实测同一条切片前几名的分差本来就小(单块峰值只差 2%),
 * 挡在分差里的那点差别不如「闪更靠后的那个」有用。
 */
export const FLASH_PAYOFF_TIE_RATIO = 0.85;

/**
 * 决定爆点闪现(flash-forward)片段:在能在保留区间内装下完整闪现窗的候选
 * 里挑**最好的那一刻**——先按持续能量分,近分时挑成片里最靠后的那个
 * (闪现的意义是「把结局先摆出来」,不是再演一遍开头)。
 *
 * 旧实现按单块峰值排、挑第一个装得下的:实测 6 个事件峰值只差 2%
 * (0.536-0.566),等于随机;而且 33ms 的一下爆点能跟 2.5 秒的大笑并列。
 * 现在排序信号来自 findPeakEvents 的持续能量分,挑窗还会盖住事件的整段爆发。
 *
 * 传保留区间而不是切片首尾:跳剪/拼接后被剪掉的内容不该出现在闪现里
 * (拼接片的段间空隙也天然被排除——保留段不会跨段)。挑不出返回 null,
 * 与 planColdOpen 同一语义:锦上添花,宁可不做不可做错。纯函数。
 *
 * words 传切片的词流(源片绝对时间)时,窗会吸附到词边界并扩到整句(见
 * flashWindow)。
 */
export function planFlashForward(
  candidates: Array<number | FlashCandidate>,
  keptSegments: Array<{ startSec: number; endSec: number }>,
  words: TranscriptWord[] = []
): ColdOpenPlan | null {
  const fits: Array<{ win: ColdOpenPlan; score: number; position: number }> = [];
  for (const raw of candidates) {
    const cand: FlashCandidate = typeof raw === "number" ? { srcSec: raw } : raw;
    const seg = keptSegments.find((s) => cand.srcSec >= s.startSec && cand.srcSec < s.endSec);
    if (!seg) continue;
    const run =
      cand.startSec !== undefined && cand.endSec !== undefined && cand.endSec > cand.startSec
        ? { startSec: cand.startSec, endSec: cand.endSec }
        : undefined;
    const win = flashWindow(cand.srcSec, seg, words, run);
    // 1e-6 容差:边界夹取的浮点误差不该把恰好达标的窗判掉
    if (win.endSec - win.startSec < FLASH_MIN_SEC - 1e-6) continue;
    fits.push({ win, score: cand.score ?? 0, position: cand.outSec ?? cand.srcSec });
  }
  if (fits.length === 0) return null;
  const best = Math.max(...fits.map((f) => f.score));
  const band = fits.filter((f) => f.score >= best * FLASH_PAYOFF_TIE_RATIO - 1e-9);
  // 同档里取成片位置最靠后的:剧透结局(它后面正片会原样再放一遍)
  return band.reduce((a, b) => (b.position > a.position ? b : a)).win;
}

/**
 * 峰值周围的闪现窗:先取 [峰值-lead, 峰值+tail],再按词边界吸附、扩到整句。
 * 0.7 秒的窗只截到半句话,所以真正决定观感的是这里的扩窗:
 * - 只认完整落在本保留段内的词(跳剪剪掉的内容不该被引子带回来);
 * - 两端吸附到词边界(不切半个词),再顺着句读(词间静音 ≤ GAP)向两侧
 *   扩到整句,总长夹在 FLASH_MAX_SEC 内;
 * - 峰值在无人声处(笑声/掌声/音效)时不做词吸附,直接给下限窗——那时的
 *   画面本身就是钩子,硬贴一句话反而错位。
 * - 传了事件的响区间 run 时,下限窗按 run 取(爆发从头到尾),超上限就砍引子
 *   留余韵——真正的高潮不能被 FLASH_MAX_SEC 削掉。
 * 纯函数。
 */
export function flashWindow(
  atSec: number,
  seg: { startSec: number; endSec: number },
  words: TranscriptWord[],
  run?: { startSec: number; endSec: number }
): ColdOpenPlan {
  let base: ColdOpenPlan = {
    startSec: Math.max(seg.startSec, atSec - FLASH_LEAD_SEC),
    endSec: Math.min(seg.endSec, atSec + FLASH_TAIL_SEC),
  };
  if (run) {
    const endSec = Math.min(seg.endSec, run.endSec + FLASH_TAIL_SEC);
    base = { startSec: Math.max(seg.startSec, run.startSec - FLASH_LEAD_SEC, endSec - FLASH_MAX_SEC), endSec };
  }
  const segWords = words.filter((w) => w.startSec >= seg.startSec - 1e-3 && w.endSec <= seg.endSec + 1e-3);
  // 窗内没有词(峰值落在无人声处)→ 保持下限窗
  if (!segWords.some((w) => w.endSec > base.startSec && w.startSec < base.endSec)) return base;

  let i = segWords.findIndex((w) => w.endSec > base.startSec);
  if (i < 0) i = 0;
  let j = i;
  for (let k = 0; k < segWords.length; k++) {
    if (segWords[k].startSec < base.endSec) j = k;
  }
  if (j < i) j = i;

  const spanSec = (a: number, b: number): number => segWords[b].endSec - segWords[a].startSec;
  while (
    i > 0 &&
    segWords[i].startSec - segWords[i - 1].endSec <= FLASH_UTTERANCE_GAP_SEC &&
    spanSec(i - 1, j) <= FLASH_MAX_SEC + 1e-6
  ) {
    i--;
  }
  while (
    j + 1 < segWords.length &&
    segWords[j + 1].startSec - segWords[j].endSec <= FLASH_UTTERANCE_GAP_SEC &&
    spanSec(i, j + 1) <= FLASH_MAX_SEC + 1e-6
  ) {
    j++;
  }
  // 初始吸附就可能超上限:base 盖住整段爆发时,首词往回收会让总长到 3 秒以上
  // (实测真片 3.34s,而且开头是从上一句尾巴「olmayacak.」切进去的残句)。
  // 超了就从头部整词整词地丢,保住爆点和它后面的余韵,窗口不切半个词。
  while (i < j && spanSec(i, j) > FLASH_MAX_SEC + 1e-6) i++;
  const snapped: ColdOpenPlan = { startSec: segWords[i].startSec, endSec: segWords[j].endSec };
  return snapped.endSec - snapped.startSec >= FLASH_MIN_SEC ? snapped : base;
}
