/**
 * 画幅填充方式:横屏素材进竖屏画幅(9:16)时,空出来的上下(或左右)怎么办。
 *
 * - `crop`(今天的做法):居中裁掉两侧。构图干净,但 16:9 进 9:16 要丢掉
 *   68% 的宽度——人脸检测没给出跟拍目标时,常常裁掉的就是主体。
 * - `blur`(本条):整帧缩到宽度、居中放在最上层;底下一层是同一帧「放大裁满
 *   + 模糊 + 压暗」,黑边变成虚化背景。什么都不丢,观感像平台自带的竖屏转换。
 *
 * 实现要点:`split` 起两路(ffmpeg 线性 `-vf` 里也必须起支路,所以这一串自带
 * `;` 与标签)。**最后一条链不带标签**,后面的滤镜(增强/字幕/变速)接在
 * `overlay` 之后继续逗号连下去——`composeVideoFilter` 的 `join(",")` 正好
 * 把它当普通一环拼进线性链。支路只在这一串里面存在,外面看不出来。
 */
export type FillMode = "crop" | "blur";

/** 向下取到偶数(cut.ts 也有一份同名工具;这里自己留一份,免得两个模块互相 import)。 */
function even(n: number): number {
  const i = Math.max(2, Math.round(n));
  return i % 2 === 0 ? i : i - 1;
}

/** 背景虚化半径(像素)。够大才不会看出是「同一张图」,又不至于糊成一团色块。 */
export const BLUR_FILL_SIGMA = 24;
/** 背景压暗量(eq brightness),让上层画面从背景里跳出来。 */
export const BLUR_FILL_DIM = -0.08;
/** 源画幅与目标画幅差这么点以内就当没差(等价:没有边要填)。 */
const ASPECT_TOLERANCE = 0.02;

/**
 * 模糊填边滤镜串(自带支路)。`outW/outH` 必须偶数——`crop` 与编码器都按偶数走。
 *
 * `force_original_aspect_ratio=increase` 保证放大到两边都不小于目标,再居中裁;
 * `decrease` 保证整帧塞进目标内(这是上层那张「完整画面」)。
 */
export function blurFillStage(outW: number, outH: number): string {
  const w = even(outW);
  const h = even(outH);
  return [
    "split=2[bg0][fg0]",
    `[bg0]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
      `gblur=sigma=${BLUR_FILL_SIGMA},eq=brightness=${BLUR_FILL_DIM}[bg]`,
    `[fg0]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
    "[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1",
  ].join(";");
}

/**
 * 这一刀到底用哪种填充(纯判定)。
 *
 * `blur` 只在「竖屏重构 + 没有跟拍目标 + 没有运镜」时开:
 * - 跟拍/运镜自己已经决定了构图,再叠模糊背景是两套主张打架;
 * - 源画幅本来就等于目标画幅时没有边要填,照旧走裁剪(省一次放大+模糊);
 * - 尺寸未知时按调用方的明确要求办(不看画幅)。
 */
export function planFill(input: {
  mode: FillMode | undefined;
  vertical: boolean;
  hasTrack: boolean;
  hasZoom: boolean;
  srcW?: number;
  srcH?: number;
  outW?: number;
  outH?: number;
}): FillMode {
  if (input.mode !== "blur") return "crop";
  if (!input.vertical || input.hasTrack || input.hasZoom) return "crop";
  const { srcW, srcH, outW, outH } = input;
  if (srcW && srcH && srcW > 0 && srcH > 0 && outW && outH && outW > 0 && outH > 0) {
    const src = srcW / srcH;
    const out = outW / outH;
    if (Math.abs(src - out) / out < ASPECT_TOLERANCE) return "crop";
  }
  return "blur";
}
