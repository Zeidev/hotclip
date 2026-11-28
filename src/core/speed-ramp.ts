/**
 * 变速(速度斜坡):爆点闪现的迷你片是「预告片」——把片中最炸的 1–3 秒提到
 * 最前面,预告片的惯例是快节奏。画面 `setpts`、声音 `atempo`(改速度不改
 * 音高,440Hz 还是 440Hz;`asetrate` 会变成卡通音),1.4× 左右最稳。
 *
 * 为什么只对爆点闪现开:钩子句冷开场是「把观众要记住的那句话再放一遍」,
 * 语速被推快就成了赶场;闪现是蒙太奇式的前置,快半拍才像预告。
 *
 * 关键约定:**setpts 放在视频滤镜链的最末尾(字幕烧录之后)**。字幕按源时间编
 * 时间轴,烧完再变速,卡拉OK 跟着画面一起快——字幕不需要单独压缩时间。
 */

/** 变速倍率(>1 = 变快)。1.4 是 atempo 单实例范围内、口播仍听得清的上限附近。 */
export const HOOK_RAMP_RATE = 1.4;
/** 源长度短于这个就不变速:再快就成了一次闪,观众来不及看清。 */
export const HOOK_RAMP_MIN_SEC = 1;
/** atempo 单个实例的合法范围(ffmpeg 限制 0.5–2.0;超出要串联,这里不做)。 */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;

/** 变速后的时长(秒);倍率非法一律按 1 算(不变速)。 */
export function rampDuration(sec: number, rate: number): number {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Number((sec / r).toFixed(3));
}

/** 倍率可用吗:有限、为正、且不近似等于 1(等于 1 = 不变速,链路逐字节不变)。 */
function usableRate(rate: number | undefined): number | null {
  if (typeof rate !== "number" || !Number.isFinite(rate) || !(rate > 0)) return null;
  if (Math.abs(rate - 1) < 1e-6) return null;
  return Math.min(ATEMPO_MAX, Math.max(ATEMPO_MIN, rate));
}

/** 视频变速滤镜;倍率等于 1 或非法返回空串。 */
export function speedVideoStage(rate: number | undefined): string {
  const r = usableRate(rate);
  if (r === null) return "";
  // 只重排时间戳,不丢帧:输出帧率不变,帧数按倍率变少
  return `setpts=(PTS-STARTPTS)/${r.toFixed(4)}`;
}

/** 音频变速滤镜(改速度不改音高);倍率等于 1 或非法返回空串。 */
export function speedAudioStage(rate: number | undefined): string {
  const r = usableRate(rate);
  return r === null ? "" : `atempo=${r.toFixed(4)}`;
}

/** 迷你片要不要变速(纯判定)。 */
export function planHookRamp(input: { sourceSec: number; isFlash: boolean }): { rate: number; outputSec: number } | null {
  if (!input.isFlash) return null;
  if (!(input.sourceSec >= HOOK_RAMP_MIN_SEC)) return null;
  return { rate: HOOK_RAMP_RATE, outputSec: rampDuration(input.sourceSec, HOOK_RAMP_RATE) };
}