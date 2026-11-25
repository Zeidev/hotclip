import type {
  SubtitleQualityIssue,
  SubtitleQualityReport,
  TranscriptWord,
} from "../shared/api-types";
import { isUncertainTiming, summarizeTimingQuality } from "../shared/transcript-quality";
import {
  captionMaxLineUnits,
  groupWordsIntoLines,
  mergeKeywordWords,
  widthUnits,
  planReadableCaptions,
  captionReadableChars,
  type CaptionReadabilityOptions,
  type AssLayout,
  type CaptionStyle,
} from "./subtitle";
import type { AppLang } from "../shared/ui-lang";

export const SUBTITLE_MAX_CPS = 20;
export const SUBTITLE_MIN_LINE_SEC = 0.45;
const OVERLAP_TOLERANCE_SEC = 0.05;

/**
 * 阅读速度预算按语言给:CJK 一个字的信息密度≈拉丁一个词,20 CPS 是中文口径;
 * 土耳其语/英语用拉丁文口径 17,否则一行挤到读不完也不报警。
 * 只影响告警线,不改行时长(`SUBTITLE_MIN_LINE_SEC` 与重叠容差照旧)。
 */
const SUBTITLE_MAX_CPS_BY_LANG: Record<AppLang, number> = { zh: 20, tr: 17, en: 17 };

/** 未指定语言 = 老口径(SUBTITLE_MAX_CPS),CLI/MCP 路径逐字节不变。 */
export function subtitleMaxCps(lang?: AppLang): number {
  return lang === undefined ? SUBTITLE_MAX_CPS : SUBTITLE_MAX_CPS_BY_LANG[lang];
}

function readableChars(words: readonly TranscriptWord[]): number {
  return Array.from(words.map((word) => word.text).join("").replace(/\s+/g, "")).length;
}

export function lintSubtitleTimeline(
  words: TranscriptWord[],
  layout: AssLayout,
  style: CaptionStyle,
  forcedBreaks: number[] = [],
  keywords: string[] = [],
  options: CaptionReadabilityOptions = {}
): SubtitleQualityReport {
  const issues: SubtitleQualityIssue[] = [];
  const maxUnits = captionMaxLineUnits(style, layout);
  const ordered = [...words].sort((a, b) => a.startSec - b.startSec);
  const overlapTolerance = Math.max(OVERLAP_TOLERANCE_SEC, options.overlapToleranceSec ?? 0);

  for (const word of ordered) {
    if (!Number.isFinite(word.startSec) || !Number.isFinite(word.endSec) || word.endSec <= word.startSec) {
      issues.push({
        code: "invalid-timing",
        severity: "error",
        startSec: Number.isFinite(word.startSec) ? word.startSec : 0,
        endSec: Number.isFinite(word.endSec) ? word.endSec : 0,
        wordCount: 1,
      });
    }
  }

  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const word = ordered[index];
    const overlap = previous.endSec - word.startSec;
    if (overlap > overlapTolerance) {
      issues.push({
        code: "overlap",
        severity: "error",
        startSec: word.startSec,
        endSec: Math.max(word.endSec, previous.endSec),
        value: Number(overlap.toFixed(3)),
        wordCount: 2,
      });
    }
  }

  const validWords = ordered.filter((word) => Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec);
  const displayWords = style === "keyword" || style === "minimal"
    ? mergeKeywordWords(validWords, keywords)
    : validWords;
  for (const word of displayWords) {
    if (widthUnits(word.text) > maxUnits) {
      issues.push({
        code: "oversize-token",
        severity: "warning",
        startSec: word.startSec,
        endSec: word.endSec,
        value: widthUnits(word.text),
        wordCount: 1,
      });
    }
  }
  const planned = options.readability ? planReadableCaptions(displayWords, maxUnits, forcedBreaks, options.endSec, options.lang) : undefined;
  const lines = planned ? planned.map((line) => line.words) : groupWordsIntoLines(displayWords, maxUnits, forcedBreaks, options.lang);
  // 无 readability 计划时按语言取预算;有计划时计划自己给(planned.maxCps)。
  const maxCpsBudget = subtitleMaxCps(options.lang);
  let maxCps = 0;
  for (const [index, line] of lines.entries()) {
    const startSec = line[0].startSec;
    const endSec = planned?.[index].endSec ?? line[line.length - 1].endSec;
    const durationSec = Math.max(0.001, endSec - startSec);
    const chars = planned ? captionReadableChars(line.map((w) => w.text).join("")) : readableChars(line);
    const cps = chars / durationSec;
    maxCps = Math.max(maxCps, cps);
    if (cps > (planned?.[index].maxCps ?? maxCpsBudget)) {
      issues.push({
        code: "reading-speed",
        severity: "warning",
        startSec,
        endSec,
        value: Number(cps.toFixed(1)),
        wordCount: line.length,
      });
    }
    if (chars >= 4 && durationSec < SUBTITLE_MIN_LINE_SEC) {
      issues.push({
        code: "short-display",
        severity: "warning",
        startSec,
        endSec,
        value: Number(durationSec.toFixed(3)),
        wordCount: line.length,
      });
    }
  }

  const timing = summarizeTimingQuality(validWords);
  for (const span of timing.uncertainSpans) {
    issues.push({
      code: "uncertain-timing",
      severity: "warning",
      startSec: span.startSec,
      endSec: span.endSec,
      wordCount: span.wordCount,
    });
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  return {
    status: hasError ? "error" : issues.length > 0 ? "warn" : "pass",
    lineCount: lines.length,
    maxCps: Number(maxCps.toFixed(1)),
    uncertainWords: validWords.filter(isUncertainTiming).length,
    issues,
  };
}
