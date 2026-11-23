import type { ClipLength, DetectionOptions, PromptLangChoice } from "./api-types";
import { normalizeGenreId } from "../core/genre";

export const CLIP_LENGTH_RANGES: Record<ClipLength, { minSec: number; maxSec: number }> = {
  short: { minSec: 10, maxSec: 30 },
  standard: { minSec: 8, maxSec: 40 },
  long: { minSec: 40, maxSec: 90 },
  extended: { minSec: 60, maxSec: 120 },
};

export function isClipLength(value: unknown): value is ClipLength {
  return typeof value === "string" && Object.hasOwn(CLIP_LENGTH_RANGES, value);
}

/** 一次检测最多产出多少条候选(v0.35:12 → 40,长视频要的是覆盖面不是精选)。 */
export const MAX_CLIPS = 40;
/** 未指定时的默认条数(v0.35:6 → 12;默认也走多窗口路径见 highlight/detect.ts)。 */
export const DEFAULT_MAX_CLIPS = 12;

export function normalizeMaxClips(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_CLIPS, Math.round(value))) : DEFAULT_MAX_CLIPS;
}

/** 提示词语言可选值:`auto` 按转写语言/文本特征判定,其余强制该语言的 prompt。 */
export const PROMPT_LANG_CHOICES: readonly PromptLangChoice[] = ["auto", "zh", "tr", "en"];

export function isPromptLangChoice(value: unknown): value is PromptLangChoice {
  return typeof value === "string" && (PROMPT_LANG_CHOICES as readonly string[]).includes(value);
}

/** 非法/缺失一律回落 `auto`(沿用语言判定),不做猜测。 */
export function normalizePromptLang(value: unknown): PromptLangChoice {
  return isPromptLangChoice(value) ? value : "auto";
}

export function detectionOptionsFromPrefs(prefs: {
  clipLength: ClipLength; maxClips: number; genreId: string; genreCustom: string; promptLang?: unknown;
}): DetectionOptions {
  return {
    clipLength: prefs.clipLength,
    maxClips: prefs.maxClips,
    genre: { id: normalizeGenreId(prefs.genreId), custom: prefs.genreCustom },
    promptLang: normalizePromptLang(prefs.promptLang),
  };
}
