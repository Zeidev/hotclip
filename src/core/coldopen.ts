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
/** 爆点距开头太近时再前置一遍显得机械重复,通行建议 <10-15 秒就跳过。 */
export const COLD_OPEN_SKIP_NEAR_START_SEC = 10;

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
 * 决定爆点闪现(flash-forward)片段:从峰值事件(按强度从高到低,调用方已
 * 过滤掉离输出开头太近的)里挑第一个能在保留区间内装下完整闪现窗的。
 * 传保留区间而不是切片首尾:跳剪/拼接后被剪掉的内容不该出现在闪现里
 * (拼接片的段间空隙也天然被排除——保留段不会跨段)。挑不出返回 null,
 * 与 planColdOpen 同一语义:锦上添花,宁可不做不可做错。纯函数。
 *
 * words 传切片的词流(源片绝对时间)时,窗会吸附到词边界并扩到整句(见
 * flashWindow);不传则退回固定下限窗。
 */
export function planFlashForward(
  peakAtSec: number[],
  keptSegments: Array<{ startSec: number; endSec: number }>,
  words: TranscriptWord[] = []
): ColdOpenPlan | null {
  for (const at of peakAtSec) {
    const seg = keptSegments.find((s) => at >= s.startSec && at < s.endSec);
    if (!seg) continue;
    const win = flashWindow(at, seg, words);
    // 1e-6 容差:边界夹取的浮点误差不该把恰好达标的窗判掉
    if (win.endSec - win.startSec >= FLASH_MIN_SEC - 1e-6) return win;
  }
  return null;
}

/**
 * 峰值周围的闪现窗:先取 [峰值-lead, 峰值+tail],再按词边界吸附、扩到整句。
 * 0.7 秒的窗只截到半句话,所以真正决定观感的是这里的扩窗:
 * - 只认完整落在本保留段内的词(跳剪剪掉的内容不该被引子带回来);
 * - 两端吸附到词边界(不切半个词),再顺着句读(词间静音 ≤ GAP)向两侧
 *   扩到整句,总长夹在 FLASH_MAX_SEC 内;
 * - 峰值在无人声处(笑声/掌声/音效)时不做词吸附,直接给下限窗——那时的
 *   画面本身就是钩子,硬贴一句话反而错位。
 * 纯函数。
 */
export function flashWindow(
  atSec: number,
  seg: { startSec: number; endSec: number },
  words: TranscriptWord[]
): ColdOpenPlan {
  const base: ColdOpenPlan = {
    startSec: Math.max(seg.startSec, atSec - FLASH_LEAD_SEC),
    endSec: Math.min(seg.endSec, atSec + FLASH_TAIL_SEC),
  };
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
  const snapped: ColdOpenPlan = { startSec: segWords[i].startSec, endSec: segWords[j].endSec };
  return snapped.endSec - snapped.startSec >= FLASH_MIN_SEC ? snapped : base;
}
