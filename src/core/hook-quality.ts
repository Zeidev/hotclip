/**
 * 钩子/标题的本地质检(纯函数,零 API):教义(hook-craft.ts)说什么,这里查
 * 什么。目的只有一个——把「模型写歪了」的几种可判定情形抓出来,交给发布文案
 * 的一次返工(publish.ts),或直接丢掉不合格的变体包装(variants.ts)。
 *
 * 判定都是确定性的字符串处理,不调模型:
 *  - empty/too-long:字段硬上限(prompt 里写死的字数/词数口径),超一个字就算错;
 *  - generic-opener:开场套话("本视频""bugün sizlere""in this video")——观众
 *    看到开头就知道要浪费时间,这是最常见的自毁写法;
 *  - hashtag-in-title:标题里塞话题标签(标签有单独字段);
 *  - duplicate:同一批里两条标题几乎是同一句话(发布提示词明说过整批要换着写);
 *  - angle-repeat:整批反复用同一个钩子角度(同上);
 *  - risk-word:复用 content-lint 的平台风险词表,不另写一份黑名单。
 *
 * 刻意不做的事:不在这里判定「承诺是否兑现」——missingHookPayoffs(qa.ts)要
 * 全片文本,而发布链路手上只有 300 字节选(publish.ts),拿它判会造出假的
 * 「没兑现」;也不做 too-short/filler-only(一个词的合法钩子会被误伤)。
 *
 * 土耳其语的正规化必须用显式字母表:"İ".toLowerCase() 得到 i + U+0307 组合符,
 * 直接 toLowerCase 后永远匹配不到 ASCII 的 "i"。
 */
import type { AppLang } from "../shared/ui-lang";
import { lintText } from "./content-lint";
import type { HookAngleId } from "./copy-templates";

/** 质检的出口:不同出口的字段上限不同,对应提示词里各自的说明。 */
export type HookSurface = "stage1" | "teaser" | "publish" | "variantTitle" | "variantTeaser";

export type HookWarnCode =
  | "empty"
  | "too-long"
  | "generic-opener"
  | "hashtag-in-title"
  | "duplicate"
  | "angle-repeat"
  | "risk-word";

export interface HookFlag {
  id: number;
  /** 命中的字段(标题/悬念句),告警文案里点名用。 */
  field: "title" | "teaser";
  codes: HookWarnCode[];
  /** 具体到数字/对比对象的细节(进返工提示词给模型看)。 */
  detail?: string;
}

export interface HookCandidate {
  id: number;
  title: string;
  /** 发布文案的简介:风险词要一起扫。 */
  description?: string;
  /** 悬念句出口(teaser/variantTeaser)读这个字段。 */
  teaser?: string;
  angle?: HookAngleId;
}

/** 计数口径:中文按字符(码点),tr/en 的片名按词,标题卡/发布标题按字符。 */
export type CountUnit = "chars" | "words";

interface Cap {
  unit: CountUnit;
  max: number;
}

/** 各出口的字数上限——数字必须与提示词里的说明一致(改提示词就改这里)。 */
const CAPS: Record<HookSurface, Record<AppLang, Cap>> = {
  stage1: {
    zh: { unit: "chars", max: 20 },
    tr: { unit: "words", max: 8 },
    en: { unit: "words", max: 12 },
  },
  teaser: {
    zh: { unit: "chars", max: 15 },
    tr: { unit: "words", max: 6 },
    en: { unit: "words", max: 8 },
  },
  publish: {
    zh: { unit: "chars", max: 30 },
    tr: { unit: "chars", max: 60 },
    en: { unit: "chars", max: 60 },
  },
  variantTitle: {
    zh: { unit: "chars", max: 20 },
    tr: { unit: "chars", max: 40 },
    en: { unit: "chars", max: 40 },
  },
  variantTeaser: {
    zh: { unit: "chars", max: 18 },
    tr: { unit: "chars", max: 36 },
    en: { unit: "chars", max: 36 },
  },
};

/** 悬念句的另一道硬闸:detect.ts 会 slice(0, 30),超了会被无声截断。 */
const TEASER_HARD_UNITS = 30;
/** 太短的标题不参与相似度判定(「差价10倍」这类短标题容易撞 bigram)。 */
const DUPLICATE_MIN_UNITS = 4;
/** 相似度阈值(Dice 系数)。 */
const DUPLICATE_THRESHOLD = 0.75;
/** 角度重复只在成规模的批次里算问题(两三条撞一次不算「整批一个套路」)。 */
const ANGLE_REPEAT_MIN_ITEMS = 3;

/** 计数:chars 用码点(不会把 emoji 劈成半个),words 按空白切。 */
export function countUnits(text: string, unit: CountUnit): number {
  const t = text.trim();
  if (!t) return 0;
  return unit === "chars" ? Array.from(t).length : t.split(/\s+/).length;
}

/** 土耳其语显式折叠(İ→i、I→ı),其余语言普通小写。 */
function fold(text: string, lang: AppLang): string {
  return lang === "tr" ? text.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase() : text.toLowerCase();
}

/** 开头的引号/括号/标点/emoji——套话判定前先剥掉。 */
const LEAD_NOISE_RE = /^(?:\s|["'“”‘’「」『』《》〈〉【】[\]()<>*·•\-–—_:;,。、,.;:!?！?])+/u;
const LEAD_EMOJI_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}️]+\s*)+/u;

function stripLead(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEAD_EMOJI_RE, "").replace(LEAD_NOISE_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 开场套话(前缀匹配,已 fold+stripLead)。只列真正的填充式开场:
 * 单独一个「bugün」不列(「Bugün 40 derece」是好标题),列的是
 * 「bugün sizlere」这种整句填充。
 */
const GENERIC_OPENERS: Record<AppLang, string[]> = {
  zh: [
    "今天聊聊", "今天给大家", "今天跟大家", "今天我们来", "大家好", "哈喽", "各位",
    "我们来", "让我们", "接下来", "本期", "这个视频", "本视频", "话不多说", "废话不多说", "众所周知",
  ],
  tr: [
    "merhaba", "selam", "iyi akşamlar", "iyi günler", "günaydın", "hoş geldiniz",
    "bugün sizlere", "bugün sizlerle", "bugün size", "bu videoda", "bu bölümde",
    "hadi bakalım", "haydi bakalım", "şimdi bakalım", "öncelikle", "arkadaşlar",
    "konuşacağız", "bakalım", "sizlere",
  ],
  en: [
    "today i", "today we", "today let", "hello", "hi everyone", "hi guys", "hey guys",
    "hey everyone", "welcome back", "welcome to", "in this video", "in today's video",
    "in this episode", "let's talk", "lets talk", "let's get into", "i want to talk",
    "a lot of people", "many people", "check this out",
  ],
};

/** 相似度判定时忽略的常见虚词(词级 Dice 用)。 */
const STOPWORDS: Record<AppLang, Set<string>> = {
  zh: new Set<string>(),
  tr: new Set(["bir", "bu", "ve", "ile", "için", "çok", "daha", "en", "da", "de", "ama", "ki", "mi", "mı"]),
  en: new Set(["the", "a", "an", "and", "or", "for", "with", "this", "that", "you", "your", "it", "is", "are", "of", "to", "in", "on"]),
};

/**
 * 相似度用的 token 集合:中文取相邻两字的 bigram(中文没有词边界),tr/en
 * 取折叠后的实词(丢掉两字母以下与虚词)。
 */
function shingles(text: string, lang: AppLang): Set<string> {
  const stripped = fold(text, lang).replace(/[\p{P}\p{S}]+/gu, lang === "zh" ? "" : " ").trim();
  if (!stripped) return new Set();
  if (lang === "zh") {
    const chars = Array.from(stripped.replace(/\s+/g, ""));
    if (chars.length === 1) return new Set(chars);
    const out = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
    return out;
  }
  return new Set(stripped.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS[lang].has(w)));
}

/** Dice 系数(2|A∩B| / (|A|+|B|));任一方为空按 0。 */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 归一化比较键(标点/符号/空白全剥,整段完全一样 = 必然重复)。 */
function dupKey(text: string, lang: AppLang): string {
  return fold(text, lang).replace(/[\p{P}\p{S}\s]+/gu, "");
}

const CODE_LABEL: Record<AppLang, Record<HookWarnCode, string>> = {
  zh: {
    empty: "字段是空的",
    "too-long": "超长",
    "generic-opener": "开头是套话(观众一看就知道要浪费时间)",
    "hashtag-in-title": "标题里塞了话题标签",
    duplicate: "与本批另一条几乎是同一句话",
    "angle-repeat": "与前面某条用了同一个钩子角度",
    "risk-word": "命中平台风险词",
  },
  tr: {
    empty: "alan boş",
    "too-long": "çok uzun",
    "generic-opener": "açılış kalıp söz (izleyici zaman kaybedeceğini anlar)",
    "hashtag-in-title": "başlıkta hashtag var",
    duplicate: "partideki başka bir başlıkla neredeyse aynı",
    "angle-repeat": "önceki bir kayıtla aynı kanca açısı",
    "risk-word": "platform risk sözcüğü var",
  },
  en: {
    empty: "the field is empty",
    "too-long": "too long",
    "generic-opener": "generic opener (the viewer knows time is about to be wasted)",
    "hashtag-in-title": "the title carries a hashtag",
    duplicate: "nearly the same line as another item in this batch",
    "angle-repeat": "reuses the same hook angle as an earlier item",
    "risk-word": "hits a platform risk term",
  },
};

/**
 * 一批候选(同一提示词一次调用产出的)逐条质检。
 * 返回只含**有问题的**条目;干净的一批返回空数组(调用方据此省掉返工)。
 */
export function checkHookQuality(items: HookCandidate[], opts: { lang: AppLang; surface: HookSurface }): HookFlag[] {
  const { lang, surface } = opts;
  const cap = CAPS[surface];
  const field: "title" | "teaser" = surface === "teaser" || surface === "variantTeaser" ? "teaser" : "title";
  const unitLabel = cap[lang].unit === "chars" ? (lang === "zh" ? "字" : "char") : lang === "zh" ? "词" : "words";
  const seen: Array<{ id: number; key: string; set: Set<string> }> = [];
  const seenAngles = new Map<HookAngleId, number>();
  const out: HookFlag[] = [];

  for (const item of items) {
    const text = ((field === "teaser" ? item.teaser : item.title) ?? "").trim();
    const codes = new Set<HookWarnCode>();
    const notes: string[] = [];

    if (!text) {
      codes.add("empty");
    } else {
      const n = countUnits(text, cap[lang].unit);
      if (n > cap[lang].max) {
        codes.add("too-long");
        notes.push(`${n} > ${cap[lang].max} ${unitLabel}`);
      }
      if (field === "teaser" && countUnits(text, "chars") > TEASER_HARD_UNITS) {
        codes.add("too-long");
        notes.push(`> ${TEASER_HARD_UNITS} char (on-screen slice)`);
      }

      const head = fold(stripLead(text), lang);
      const opener = GENERIC_OPENERS[lang].find((p) => head.startsWith(p));
      if (opener) {
        codes.add("generic-opener");
        notes.push(`"${opener}"`);
      }
      if (text.includes("#")) codes.add("hashtag-in-title");

      // 风险词:标题与简介一起扫(与 lint 共用同一份规则表)
      const risky = [...lintText(text), ...(item.description ? lintText(item.description) : [])];
      if (risky.length > 0) {
        codes.add("risk-word");
        notes.push(risky.map((h) => `"${h.term}"`).join("/"));
      }

      // 重复与角度:短标题不参与(误报太多)
      const units = countUnits(text, cap[lang].unit);
      if (units >= DUPLICATE_MIN_UNITS) {
        const key = dupKey(text, lang);
        const set = shingles(text, lang);
        const hit = seen.find((s) => s.key === key || dice(s.set, set) >= DUPLICATE_THRESHOLD);
        if (hit) {
          codes.add("duplicate");
          notes.push(`[${hit.id}]`);
        }
        seen.push({ id: item.id, key, set });
      }
      if (item.angle) {
        const first = seenAngles.get(item.angle);
        if (first !== undefined && items.length >= ANGLE_REPEAT_MIN_ITEMS) {
          codes.add("angle-repeat");
          notes.push(`${item.angle} = [${first}]`);
        } else if (first === undefined) {
          seenAngles.set(item.angle, item.id);
        }
      }
    }

    if (codes.size > 0) {
      out.push({ id: item.id, field, codes: [...codes], ...(notes.length > 0 ? { detail: notes.join("; ") } : {}) });
    }
  }
  return out;
}

/** 把质检结论写成给模型看的返工清单(简短、原生、带具体数字)。 */
export function hookFlagNotes(flags: HookFlag[], lang: AppLang): string {
  return flags
    .map((f) => {
      const label = f.codes.map((c) => CODE_LABEL[lang][c]).join("; ");
      return lang === "zh"
        ? `[${f.id}] ${label}${f.detail ? `(${f.detail})` : ""}`
        : `[${f.id}] ${label}${f.detail ? ` (${f.detail})` : ""}`;
    })
    .join("\n");
}

/**
 * 丢掉没有差异化价值的包装(变体):与原版或已保留的同批包装标题几乎一样、
 * 或者角度撞了。第一个满足条件的留下,后面的丢——顺序与 coverRank 因此不变。
 *
 * get/original 用取值函数传,避免变体模块的结构(angle 埋在 post 里)渗进来。
 */
export function filterDuplicatePackagings<T>(
  items: T[],
  get: (item: T) => { title: string; angle?: HookAngleId },
  original: { title: string; angle?: HookAngleId },
  lang: AppLang
): T[] {
  const keptKeys: Array<{ key: string; set: Set<string> }> = [];
  const keptAngles = new Set<HookAngleId>();
  const out: T[] = [];

  const originalKey = dupKey(original.title, lang);
  const originalSet = shingles(original.title, lang);
  if (originalKey) keptKeys.push({ key: originalKey, set: originalSet });
  if (original.angle) keptAngles.add(original.angle);

  for (const item of items) {
    const v = get(item);
    const title = v.title.trim();
    if (!title) continue;
    const key = dupKey(title, lang);
    const set = shingles(title, lang);
    const units = countUnits(title, "chars");
    const dup =
      keptKeys.some((s) => s.key === key) ||
      (units >= DUPLICATE_MIN_UNITS && keptKeys.some((s) => dice(s.set, set) >= DUPLICATE_THRESHOLD));
    if (dup) continue;
    if (v.angle && keptAngles.has(v.angle)) continue;
    keptKeys.push({ key, set });
    if (v.angle) keptAngles.add(v.angle);
    out.push(item);
  }
  return out;
}
