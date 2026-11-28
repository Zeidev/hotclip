/**
 * 剪辑度量(edit metrics):QA 其余检查回答「片子有没有坏」(黑屏/长静音/时长/
 * 半词),这里回答「剪得好不好」——只看成品本身,不看剪辑计划:
 *
 * - 每个切点画面到底变了多少:变了才叫一刀,没变的那一刀等于没剪;
 * - 镜头是不是一样长(变异系数):一样长像节拍器,人剪的节奏有起伏;
 * - 最长「画面近静止」时长:比 freezedetect 的 3s 门槛细,给报告一个连续量。
 *
 * 三条都从同一条 96×96 灰度帧流里算(见 qa.ts scanClip):一帧一个比值,
 * 长片也只有几千个数,不占内存。
 *
 * 度量单位是**变化像素占比**而不是平均绝对差:平均差会被画面尺寸和缩放
 * 稀释(同一个姿态变化,1080p 全分辨率和 96×96 缩略图读出来差几倍),比例
 * 不会——「有多少像素真的动了」和缩放尺度无关,阈值才立得住。
 *
 * 音频侧故意不在这里量:每条缝上都有 30ms 边缘淡化(cut.ts EDGE_FADE_SEC),
 * 缝两侧的音量本来就是渐隐渐入,量「切点上的音量台阶」量不出东西;真正听得
 * 出来的两种音频缺陷已经各有归属——切进发声由 qa.countMidWordCuts 按真峰值
 * 轨判(见 report.midWordCuts),长静音由 silencedetect 判。
 */

/** 单像素算「变了」的灰度差阈值(0..255,含等号:正好 8 视为没变)。 */
export const FRAME_PIXEL_DELTA = 8;
/** 切点变化像素占比低于此值 = 画面几乎没变,这一刀剪了等于没剪。 */
export const INVISIBLE_CUT_FRACTION = 0.006;
/** 帧间变化像素占比低于此值 = 该帧相对上一帧近静止。 */
export const STATIC_FRAME_FRACTION = 0.02;
/** 镜头长度变异系数低于此值且镜头够多 = 节拍器(每段一样长,不像人剪的)。 */
export const METRONOME_CV = 0.1;

/**
 * 相邻两帧「变了多少」:变化像素占比(0..1)。
 * 两帧尺寸不一致或为空时返回 0(调用方不该走到这里)。
 */
export function frameChangeFraction(prev: Uint8Array, cur: Uint8Array): number {
  const n = Math.min(prev.length, cur.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(cur[i] - prev[i]) > FRAME_PIXEL_DELTA) changed++;
  }
  return changed / n;
}

/**
 * 灰度帧流的增量差分器:把管道块喂进来,吐出一帧一个「变化像素占比」。
 * 长片也只留一帧在内存里(整条流留在内存里在 10 分钟片子上就是几十 MB)。
 */
export function createFrameDiffMeter(frameBytes: number): { push(chunk: Uint8Array): number[] } {
  let prev: Uint8Array | null = null;
  let pending = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): number[] {
      const out: number[] = [];
      if (!(frameBytes > 0) || chunk.length === 0) return out;
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let off = 0;
      while (merged.length - off >= frameBytes) {
        // 复制一帧:管道块会被复用/回收,留引用等于留半截缓冲
        const frame = merged.slice(off, off + frameBytes);
        if (prev) out.push(frameChangeFraction(prev, frame));
        prev = frame;
        off += frameBytes;
      }
      pending = merged.slice(off);
      return out;
    },
  };
}

/** 一个切点的画面变化。 */
export interface CutChange {
  /** 切点在输出时间轴上的时刻(秒)。 */
  atSec: number;
  /** 变化像素占比(0..1)。 */
  change: number;
}

/**
 * 切点 → 画面变化。diffs[i] 是第 i−1 帧到第 i 帧的变化(即 i/fps 处的接缝);
 * 切点在 t 附近,计划时刻与真实帧网格有一帧以内的误差,所以取 k−1..k+1 三处
 * 里的较大者:静止画面里三处都小(不会把「没变」误报成「变了」),动起来的
 * 画面里至少一处是真变化(往「看得见」的方向误判,而假告警只朝反方向发生)。
 * 同一帧网格上的重复切点只算一次(计划里不该有,但防病态输入)。
 */
export function cutFrameChanges(diffs: number[], fps: number, cutTimesSec: number[]): CutChange[] {
  if (!(fps > 0) || diffs.length === 0) return [];
  const seen = new Set<number>();
  const out: CutChange[] = [];
  for (const t of cutTimesSec) {
    if (!(t > 0)) continue;
    const k = Math.round(t * fps);
    if (seen.has(k)) continue;
    const cands = [diffs[k - 1], diffs[k], diffs[k + 1]].filter(
      (v) => typeof v === "number" && Number.isFinite(v)
    );
    if (cands.length === 0) continue;
    seen.add(k);
    out.push({ atSec: Number(t.toFixed(2)), change: Number(Math.max(...cands).toFixed(5)) });
  }
  return out;
}

/** 切点划出的镜头长度(秒);片头片尾各算一个天然切点。 */
export function shotIntervals(cutTimesSec: number[], durationSec: number): number[] {
  if (!(durationSec > 0)) return [];
  const pts = [...new Set([0, ...cutTimesSec.filter((t) => t > 0 && t < durationSec), durationSec])].sort(
    (a, b) => a - b
  );
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) out.push(pts[i] - pts[i - 1]);
  return out;
}

/** 镜头节奏统计。 */
export interface ShotRhythm {
  /** 最长镜头(观众实际感到「一个镜头拖了多久」)。 */
  longestShotSec: number;
  /** 镜头长度变异系数(总体标准差/均值);镜头少于 3 段时为 null(谈不上节奏)。 */
  cv: number | null;
}

export function shotRhythm(intervals: number[]): ShotRhythm {
  const list = intervals.filter((v) => Number.isFinite(v) && v > 0);
  if (list.length === 0) return { longestShotSec: 0, cv: null };
  const longestShotSec = Number(Math.max(...list).toFixed(2));
  if (list.length < 3) return { longestShotSec, cv: null };
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  if (!(mean > 0)) return { longestShotSec, cv: null };
  const variance = list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length;
  return { longestShotSec, cv: Number((Math.sqrt(variance) / mean).toFixed(3)) };
}

/**
 * 最长「画面近静止」时长(秒):连续若干帧间变化都低于 STATIC_FRAME_FRACTION
 * 的一段。run 个连续低变化 = 跨 run+1 帧的画面。字幕/运镜这类细节在 96×96
 * 上会被平均掉,所以这条只作连续量记录,**不产生告警**(原始分辨率上的
 * freezedetect 已经管告警)。
 */
export function longestStaticSec(diffs: number[], fps: number): number {
  if (!(fps > 0) || diffs.length === 0) return 0;
  let best = 0;
  let run = 0;
  for (const d of diffs) {
    if (d < STATIC_FRAME_FRACTION) run++;
    else {
      if (run > best) best = run;
      run = 0;
    }
  }
  if (run > best) best = run;
  return best === 0 ? 0 : Number(((best + 1) / fps).toFixed(2));
}

/** 一条成片的剪辑度量(进 clips.json 的 qa.edit)。 */
export interface EditMetrics {
  /** 参与度量的切点数(输出时间轴)。 */
  cuts: number;
  /** 切点画面变化的最小值(变化像素占比)——「最看不出来的一刀」;无切点为 null。 */
  minCutChange: number | null;
  /** 画面几乎没变的切点数(< INVISIBLE_CUT_FRACTION):剪了等于没剪。 */
  invisibleCuts: number;
  /** 最长镜头时长(秒)。 */
  longestShotSec: number;
  /** 镜头长度变异系数;镜头少于 3 段为 null。 */
  cv: number | null;
  /** 最长画面近静止时长(秒)。 */
  longestStaticSec: number;
}

/**
 * 组装一条成片的剪辑度量。纯函数:帧间变化序列 + 帧率 + 切点(输出时间轴)。
 * 帧率为 0(探测失败)时只给镜头节奏,画面那半边留空。
 */
export function computeEditMetrics(input: {
  frameDiffs: number[];
  fps: number;
  cutTimesSec: number[];
  durationSec: number;
}): EditMetrics {
  const cuts = cutFrameChanges(input.frameDiffs, input.fps, input.cutTimesSec);
  const rhythm = shotRhythm(shotIntervals(input.cutTimesSec, input.durationSec));
  return {
    cuts: cuts.length,
    minCutChange: cuts.length > 0 ? Math.min(...cuts.map((c) => c.change)) : null,
    invisibleCuts: cuts.filter((c) => c.change < INVISIBLE_CUT_FRACTION).length,
    longestShotSec: rhythm.longestShotSec,
    cv: rhythm.cv,
    longestStaticSec: longestStaticSec(input.frameDiffs, input.fps),
  };
}
