/**
 * 审阅反馈回流:审阅台的采用/否决是最真实的偏好信号,落成本地记忆档,
 * 下次检测时注入提示词——越用越懂这个用户,偏好数据不出本机。
 * (video-use project.md 会话记忆思路的 hotclip 化:桌面端积累,CLI/MCP/
 * 录播监听三边同享。)记忆只是参考证据,内容质量永远是第一判据。
 */
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join, dirname } from "path";
import type { ReviewedCandidate } from "../shared/api-types";
import type { PromptLang } from "./highlight/prompt";

export type { ReviewedCandidate };

/** 一场审阅(一次导出点击):采用了谁、放弃了谁。 */
export interface ReviewRecord {
  /** ISO 绝对时间。 */
  at: string;
  /** 源视频文件名(不含路径,不泄露目录结构)。 */
  video: string;
  kept: ReviewedCandidate[];
  rejected: ReviewedCandidate[];
}

/** 只留最近 N 场——偏好会变,老记忆该忘就忘。 */
const MAX_RECORDS = 40;
/** 提示词每类(采用/否决)注入的样例上限——控 token,也防淹没正文。 */
const MAX_EXAMPLES = 6;

const memoryPath = (userDataDir: string): string => join(userDataDir, "review-memory.json");

/** 读记忆档;缺失/损坏一律当空(记忆丢了重新积累,绝不挡管线)。 */
export async function loadReviewMemory(userDataDir: string): Promise<ReviewRecord[]> {
  try {
    const raw = JSON.parse(await readFile(memoryPath(userDataDir), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is ReviewRecord =>
        !!r && typeof (r as ReviewRecord).at === "string" && Array.isArray((r as ReviewRecord).kept) && Array.isArray((r as ReviewRecord).rejected)
    );
  } catch {
    return [];
  }
}

/** 追加一场审阅并裁旧;临时文件+rename 原子落盘。 */
export async function recordReview(userDataDir: string, record: ReviewRecord): Promise<void> {
  // 全采用且无否决也记录:采用样例同样是偏好证据
  const all = [...(await loadReviewMemory(userDataDir)), record].slice(-MAX_RECORDS);
  const file = memoryPath(userDataDir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
  await rename(tmp, file);
}

/** 摘样例:新场次优先,标题去重,每类最多 MAX_EXAMPLES 条。 */
export function pickExamples(records: ReviewRecord[], kind: "kept" | "rejected"): ReviewedCandidate[] {
  const out: ReviewedCandidate[] = [];
  const seen = new Set<string>();
  for (const rec of [...records].reverse()) {
    for (const c of rec[kind]) {
      if (!c?.title || seen.has(c.title)) continue;
      seen.add(c.title);
      out.push(c);
      if (out.length >= MAX_EXAMPLES) return out;
    }
  }
  return out;
}

const exampleLine = (c: ReviewedCandidate, lang: PromptLang): string => {
  const kw =
    c.keywords && c.keywords.length > 0
      ? lang === "zh"
        ? `,关键词:${c.keywords.join("、")}`
        : lang === "tr"
          ? `, anahtar kelimeler: ${c.keywords.join(", ")}`
          : `, keywords: ${c.keywords.join(", ")}`
      : "";
  if (lang === "zh") return `- 《${c.title}》钩子「${c.hook}」(${Math.round(c.durationSec)}s,当时评分 ${c.score}${kw})`;
  if (lang === "tr") return `- "${c.title}" kancası "${c.hook}" (${Math.round(c.durationSec)}s, o zaman ${c.score} puan${kw})`;
  return `- "${c.title}" hook "${c.hook}" (${Math.round(c.durationSec)}s, scored ${c.score}${kw})`;
};

/**
 * 提示词注入段:没有记忆返回 ""。要求 LLM 总结共性而不是避开字面——
 * 否决样例的价值在"这类不要",不在"这几个标题不要"。
 */
export function reviewMemorySection(records: ReviewRecord[], lang: PromptLang): string {
  const rejected = pickExamples(records, "rejected");
  const kept = pickExamples(records, "kept");
  if (rejected.length === 0 && kept.length === 0) return "";
  const zh = lang === "zh";
  if (zh) {
    let s = `\n\n【用户审阅偏好】(来自本机历史审阅记录,仅作参考——内容质量仍是第一判据。请总结下面样例的共性,按"同类少选/同类优先"调整,不是机械避开相同字面)`;
    if (rejected.length > 0) s += `\n用户否决过的候选(同类少选):\n${rejected.map((c) => exampleLine(c, lang)).join("\n")}`;
    if (kept.length > 0) s += `\n用户采用过的候选(同类优先):\n${kept.map((c) => exampleLine(c, lang)).join("\n")}`;
    return s;
  }
  if (lang === "tr") {
    let s = `\n\n[Kullanıcının inceleme tercihleri] (bu bilgisayardaki inceleme kayıtlarından; sadece yol gösterir — içerik kalitesi yine ilk ölçüt. Aşağıdaki örneklerin ortak yönlerini çıkarıp "benzerlerini az seç / benzerlerini öne al" diye ayarla; aynı başlıklardan mekanik olarak kaçınmak değil)`;
    if (rejected.length > 0) s += `\nKullanıcının reddettiği adaylar (benzerlerini daha az seç):\n${rejected.map((c) => exampleLine(c, lang)).join("\n")}`;
    if (kept.length > 0) s += `\nKullanıcının kabul ettiği adaylar (benzerlerini öne al):\n${kept.map((c) => exampleLine(c, lang)).join("\n")}`;
    return s;
  }
  let s = `\n\n[User review history] (from local review records, advisory only — content quality still rules. Generalize the patterns below; adjust toward "more like kept / fewer like rejected", never just avoid identical titles)`;
  if (rejected.length > 0) s += `\nPreviously rejected (pick fewer like these):\n${rejected.map((c) => exampleLine(c, lang)).join("\n")}`;
  if (kept.length > 0) s += `\nPreviously kept (pick more like these):\n${kept.map((c) => exampleLine(c, lang)).join("\n")}`;
  return s;
}
