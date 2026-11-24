import type { TranscriptWord } from "../shared/api-types";

/**
 * 出厂屏蔽词。三档混在一起:中文脏话、英文脏话、土耳其语脏话——土耳其语
 * 创作者拿到的默认表不能只有中文词(一个都命中不了,等于没开)。
 * 加词要连带想「整词还是子串」:下面的 latin 判定按 Unicode 字母算,
 * 所以 "göt" 只命中独立的 göt,不会误伤 götür。
 */
export const DEFAULT_SENSITIVE_WORDS = [
  "他妈的", "妈的", "操你", "傻逼", "草泥马",
  "fuck", "fucking", "shit", "bitch",
  "amk", "aq", "oç", "orospu", "siktir", "sikeyim", "sik", "piç", "yavşak", "göt", "şerefsiz",
];

export interface TimedRange { startSec: number; endSec: number }

export function sanitizeSensitiveWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((term): term is string => typeof term === "string").map((term) => term.trim()).filter(Boolean))].slice(0, 100);
}

function mergeRanges(ranges: TimedRange[]): TimedRange[] {
  const sorted = ranges.filter((r) => r.endSec > r.startSec).sort((a, b) => a.startSec - b.startSec);
  const out: TimedRange[] = [];
  for (const range of sorted) {
    const prev = out.at(-1);
    if (prev && range.startSec <= prev.endSec + 0.02) prev.endSec = Math.max(prev.endSec, range.endSec);
    else out.push({ ...range });
  }
  return out;
}

/** 拉丁字母/数字(Unicode 口径)——土耳其语的 ışğçöü 也算字母,不能当非拉丁处理。 */
const LATIN_WORD_CHAR = /[\p{Script=Latin}\p{N}]/u;
const LATIN_WORD_END = /[\p{Script=Latin}\p{N}]$/u;
const LATIN_WORD_START = /^[\p{Script=Latin}\p{N}]/u;

/** Match CJK phrases literally and Latin terms as whole words, then map to word timestamps. */
export function findSensitiveRanges(words: TranscriptWord[], terms: string[], paddingSec = 0.06): TimedRange[] {
  let joined = "";
  const owners: number[] = [];
  words.forEach((word, index) => {
    const normalized = word.text.normalize("NFC").toLocaleLowerCase();
    if (LATIN_WORD_END.test(joined) && LATIN_WORD_START.test(normalized)) {
      joined += " ";
      owners.push(-1);
    }
    for (const ch of normalized) {
      joined += ch;
      owners.push(index);
    }
  });
  const ranges: TimedRange[] = [];
  for (const raw of sanitizeSensitiveWords(terms)) {
    const term = raw.normalize("NFC").toLocaleLowerCase();
    // 整词判定要按 Unicode 字母算:只测 [a-z] 时 "göt" 会被当成非拉丁词走子串匹配,
    // 于是 "götür" 也被屏蔽——土耳其语默认表会误伤正常词。
    const latin = /^[\p{Script=Latin}\p{N} ]+$/u.test(term);
    for (let from = 0; from <= joined.length - term.length;) {
      const at = joined.indexOf(term, from);
      if (at < 0) break;
      const before = joined[at - 1] ?? "";
      const after = joined[at + term.length] ?? "";
      const boundaryOk = !latin || (!LATIN_WORD_CHAR.test(before) && !LATIN_WORD_CHAR.test(after));
      if (boundaryOk) {
        const first = words[owners[at]];
        const last = words[owners[at + term.length - 1]];
        if (first && last) ranges.push({ startSec: Math.max(0, first.startSec - paddingSec), endSec: last.endSec + paddingSec });
      }
      from = at + Math.max(1, term.length);
    }
  }
  return mergeRanges(ranges);
}

/** Convert absolute source ranges onto the final concatenated output timeline. */
export function mapSensitiveRanges(words: TranscriptWord[], terms: string[], segments: TimedRange[]): TimedRange[] {
  const source = findSensitiveRanges(words, terms);
  const mapped: TimedRange[] = [];
  let offset = 0;
  for (const segment of segments) {
    for (const range of source) {
      const start = Math.max(segment.startSec, range.startSec);
      const end = Math.min(segment.endSec, range.endSec);
      if (end > start) mapped.push({ startSec: offset + start - segment.startSec, endSec: offset + end - segment.startSec });
    }
    offset += segment.endSec - segment.startSec;
  }
  return mergeRanges(mapped);
}
