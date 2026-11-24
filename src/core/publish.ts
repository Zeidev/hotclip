/**
 * 发布文案生成:为每条切片批量生成「发布标题 + 话题标签 + 两句简介」,
 * 落成 mp4 旁的 .post.txt(创作者直接复制粘贴)并写进 clips.json——
 * 补上「切完直接发」的最后一公里:片子有了,发布框里写什么。
 *
 * 素材全部来自检测阶段的证据链(title/hook/正文/keywords),一次 LLM 调用
 * 批量生成所有选中切片。fail-open:生成失败/缺条都只是没有文案,绝不拖垮
 * 导出。纯函数(prompt/解析/成文)可单测;LLM 调用注入。
 */
import type { LlmConfig } from "../shared/api-types";
import type { AppLang } from "../shared/ui-lang";
import { AIGC_POST_NOTE } from "../shared/ui-lang";
import { stripThinkBlocks } from "./highlight/prefilter";
import { ctaMenu, hookAngleMenu, isCtaType, isHookAngle, type CtaTypeId, type HookAngleId } from "./copy-templates";
import { hookCraftSection } from "./hook-craft";
import { checkHookQuality, hookFlagNotes, type HookFlag } from "./hook-quality";

/** 单条切片的发布文案。 */
export interface PublishCopy {
  /** 发布标题(平台风格,带钩子,≤30字)。 */
  title: string;
  /** 话题标签(含 # 前缀,3-6 个)。 */
  hashtags: string[];
  /** 一两句简介(补充钩子、引导互动)。 */
  description: string;
  /** 标题采用的钩子角度(copy-templates 菜单;缺省=旧数据或模型没标)。 */
  angle?: HookAngleId;
  /** 收尾行动号召一句(复制时缀在简介后)。 */
  cta?: string;
  /** CTA 类型(copy-templates 菜单)。 */
  ctaType?: CtaTypeId;
}

/** 生成输入:每条切片的证据链素材。 */
export interface PublishSource {
  id: number;
  title: string;
  hook: string;
  /** 片内正文(超长会被截断)。 */
  text: string;
  keywords: string[];
  /** 实用密度达线(v0.14):文案要转收藏/搜索导向(CTA 收藏、标题搜索句式)。 */
  saveWorthy?: boolean;
}

/** 与 detect.ts 的 chatComplete 同形的注入点。 */
export type PublishChatFn = (llm: LlmConfig, system: string, user: string, signal?: AbortSignal) => Promise<string>;

/** 单次生成超时。 */
export const PUBLISH_TIMEOUT_MS = 90_000;
/** 正文素材截断长度(标题/钩子/关键词才是主料,正文只是补语境)。 */
const TEXT_EXCERPT_CHARS = 300;
const MAX_HASHTAGS = 6;

export function publishSystemPrompt(lang: AppLang): string {
  if (lang === "zh") {
    return [
      "你是短视频运营,为每条切片写发布文案(抖音/小红书/视频号通用)。",
      "每条输出:title=发布标题(≤30字,别用片名原文照抄)。下笔前先从钩子角度菜单里挑最贴合内容的一个,整批切片换着用,别全走同一个套路:",
      hookAngleMenu("zh"),
      // 2026 算法对齐:收藏率与搜索权重最高——标题埋观众会搜的词,干货片 CTA 转收藏/合集
      "【2026 算法要点】平台现在收藏率与搜索权重最高:标题优先写成「观众会在搜索框里打的问题/关键词句式」(把片内的具体名词/数字埋进标题,不要只写情绪词);标了[可收藏]的干货片,ctaType 必须选 save,CTA 引导「收藏起来」或「更多同场内容看主页合集」,标题走干货句式。",
      "每个标题只走一条写法;同一批条目的角度要错开,不要整批一个套路。",
      hookCraftSection("zh"),
      "hashtags=3-6 个话题标签(带#,垂类词优先,泛词最多1个);",
      "description=一两句简介(补充钩子或语境,≤60字,不要堆表情);",
      "cta=一句收尾行动号召(≤20字),类型从菜单里挑与内容匹配的:",
      ctaMenu("zh"),
      '严格只输出 JSON:{"posts":[{"id":1,"angle":"question","title":"…","hashtags":["#…"],"description":"…","ctaType":"comment","cta":"…"}]},id 与输入一一对应,angle/ctaType 必须用菜单里的 id。',
    ].join("\n");
  }
  if (lang === "tr") {
    return [
      "Kısa video sosyal medya yöneticisisin; her klip için yayın metni yazıyorsun (TikTok / Shorts / Reels).",
      "Her klip için üret: title = yayın başlığı (≤ 60 karakter, klip adını birebir kopyalama). Yazmaya başlamadan önce şu kanca açısı menüsünden içeriğe en uygununu seç; partide açıları değiştir, hepsi aynı kalıba girmesin:",
      hookAngleMenu("tr"),
      "[2026 algoritma notu] Kaydetme ve arama artık en yüksek ağırlığa sahip: başlığı izleyicinin arama kutusuna yazacağı biçimde kur (klibin somut isimlerini/sayılarını başlığa göm, yalnız duygu sözcüğü yazma); [kaydetmeye değer] işaretli kliplerde ctaType mutlaka save olsun, CTA \"sonra bakmak için kaydet\" desin ya da profil koleksiyonuna yönlendirsin, başlık bilgi veren bir kalıpta kalsın.",
      "Her başlık tek bir yazma yolu izlesin; açılar partiye dağılsın, hepsi aynı kalıba girmesin.",
      hookCraftSection("tr"),
      "hashtags = 3-6 etiket (# ile, niş terimler önce, en fazla bir genel etiket);",
      "description = bir iki cümle (≤ 120 karakter, kancayı sürdür, emoji yığma);",
      "cta = kapanışta tek bir eylem çağrısı (≤ 40 karakter), türü içeriğe uyan menüden seç:",
      ctaMenu("tr"),
      `Yalnızca KESİN JSON döndür: {"posts":[{"id":1,"angle":"question","title":"...","hashtags":["#..."],"description":"...","ctaType":"comment","cta":"..."}]}; id değerleri girdiyle birebir eşleşsin, angle/ctaType menüdeki id olsun.`,
    ].join("\n");
  }
  return [
    "You are a short-video social manager writing post copy for each clip (TikTok/Shorts/Reels).",
    "For each clip output: title = a post title (≤ 60 chars, don't copy the clip name verbatim). Pick the best-fitting hook angle from this menu first, and vary angles across the batch:",
    hookAngleMenu("en"),
    "[2026 algorithm notes] Saves and search now carry the most weight: prefer titles phrased as what viewers would type into search (embed the clip's concrete nouns/numbers, not just emotion words); clips tagged [save-worthy] must use ctaType=save with a 'save this for later' CTA and a how-to style title.",
    "Each title follows a single writing route, and the angles spread across the batch instead of repeating one pattern.",
    hookCraftSection("en"),
    "hashtags = 3-6 tags (with #, niche terms first, at most one generic tag);",
    "description = one or two sentences (≤ 120 chars, extend the hook, no emoji spam);",
    "cta = one closing call-to-action line (≤ 40 chars), typed from this menu to match the content:",
    ctaMenu("en"),
    'Output STRICT JSON only: {"posts":[{"id":1,"angle":"question","title":"…","hashtags":["#…"],"description":"…","ctaType":"comment","cta":"…"}]}, ids matching the input, angle/ctaType from the menus.',
  ].join("\n");
}

/**
 * Field labels of the per-clip material block. A Turkish run used to get the
 * Chinese labels here ("片名:"/"钩子:"), which the model then echoed back into
 * Turkish copy; the labels follow the copy language now.
 */
const USER_LABELS: Record<AppLang, { title: string; hook: string; keywords: string; save: string; body: string }> = {
  zh: { title: "片名", hook: "钩子", keywords: "关键词", save: "[可收藏]", body: "正文节选" },
  tr: { title: "Klip adı", hook: "Kanca", keywords: "Anahtar kelimeler", save: "[kaydetmeye değer]", body: "Metinden alıntı" },
  en: { title: "Clip", hook: "Hook", keywords: "Keywords", save: "[save-worthy]", body: "Body excerpt" },
};

export function publishUserPrompt(sources: PublishSource[], lang: AppLang): string {
  const L = USER_LABELS[lang];
  return sources
    .map((s) => {
      const kw = s.keywords.length > 0 ? ` ${L.keywords}:${s.keywords.join("/")}` : "";
      const save = s.saveWorthy ? ` ${L.save}` : "";
      return `[${s.id}]${save} ${L.title}:${s.title} ${L.hook}:${s.hook}${kw}\n${L.body}:${s.text.slice(0, TEXT_EXCERPT_CHARS)}`;
    })
    .join("\n\n");
}

/**
 * 从一个 LLM 输出对象里解析文案字段(title 必填,其余按约定校验)。
 * 发布文案与一片多版(variants.ts)共用同一套字段口径。
 */
export function parsePostFields(p: unknown): PublishCopy | null {
  const rec = p as {
    title?: unknown; hashtags?: unknown; description?: unknown;
    angle?: unknown; cta?: unknown; ctaType?: unknown;
  } | null;
  if (!rec || typeof rec.title !== "string" || !rec.title.trim()) return null;
  const hashtags = Array.isArray(rec.hashtags)
    ? rec.hashtags
        .filter((h): h is string => typeof h === "string" && h.trim().length > 1)
        .map((h) => (h.trim().startsWith("#") ? h.trim() : `#${h.trim()}`))
        .slice(0, MAX_HASHTAGS)
    : [];
  // 角度/CTA 类型:菜单外的值直接丢弃(fail-open 成"没标"),不猜不改写
  const cta = typeof rec.cta === "string" && rec.cta.trim() ? rec.cta.trim() : undefined;
  return {
    title: rec.title.trim(),
    hashtags,
    description: typeof rec.description === "string" ? rec.description.trim() : "",
    ...(isHookAngle(rec.angle) ? { angle: rec.angle } : {}),
    ...(cta ? { cta } : {}),
    ...(cta && isCtaType(rec.ctaType) ? { ctaType: rec.ctaType } : {}),
  };
}

/** 解析生成输出 → id→文案;垃圾输出返回空 Map(fail-open 到"没有文案")。 */
export function parsePublishCopies(content: string, validIds: Set<number>): Map<number, PublishCopy> {
  const out = new Map<number, PublishCopy>();
  const cleaned = stripThinkBlocks(content);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return out;
  }
  const posts = (obj as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return out;
  for (const p of posts) {
    const rec = p as { id?: unknown };
    const id = Number(rec.id);
    if (!Number.isInteger(id) || !validIds.has(id)) continue;
    const copy = parsePostFields(p);
    if (copy) out.set(id, copy);
  }
  return out;
}

/** 返工提示词的系统侧抬头(只改点名的问题,别顺手重写整批)。 */
const REWORK_HEADER: Record<AppLang, string> = {
  zh: "\n\n【返工】下面是上一稿被判不合格的条目。只改点名的问题,其他字段原样保留;angle/ctaType 不动(除非点名的是角度重复);仍然只输出 JSON,id 只写被点名的这些。",
  tr: "\n\n【Yeniden düzenleme】Aşağıdakiler önceki turda kusurlu bulunan kayıtlar. Yalnızca belirtilen kusuru düzelt, diğer alanlar aynı kalsın; angle/ctaType değişmesin (yalnızca açı tekrarı belirtilmişse değişebilir). Yine sadece JSON döndür ve id olarak yalnız belirtilenleri yaz.",
  en: "\n\n【Rework】Below are the items flagged in the previous pass. Fix only the named flaw and leave the other fields as they were; keep angle/ctaType unless the flaw is a repeated angle. Output JSON only, listing just the flagged ids.",
};

const REWORK_TITLES: Record<AppLang, string> = {
  zh: "当前标题:",
  tr: "Şu anki başlıklar:",
  en: "Current titles:",
};

/**
 * 返工的 user 提示词:素材块沿用第一次那一份(模型看得到同一份证据),
 * 后面接「现在这些标题」+ 逐条问题清单。纯函数,可单测。
 */
export function publishRewritePrompt(
  sources: PublishSource[],
  current: Map<number, PublishCopy>,
  flags: HookFlag[],
  lang: AppLang
): string {
  const list = flags
    .map((f) => `[${f.id}] ${current.get(f.id)?.title ?? ""}`)
    .join("\n");
  return [publishUserPrompt(sources, lang), REWORK_TITLES[lang], list, hookFlagNotes(flags, lang)].join("\n");
}

/**
 * 只把点名条目的返工结果并回原稿:文本没变的、以及比原稿问题更多的,一律
 * 丢掉(机器不能把文案改得更差)。角度重复那一条允许换 angle,其余保留
 * 第一次的 angle/ctaType。
 */
function mergeRewrites(base: Map<number, PublishCopy>, rewrites: Map<number, PublishCopy>, flags: HookFlag[], lang: AppLang): void {
  const byId = new Map(flags.map((f) => [f.id, f]));
  for (const [id, copy] of rewrites) {
    const flag = byId.get(id);
    const prev = base.get(id);
    if (!flag || !prev) continue;
    if (copy.title.trim() === prev.title.trim()) continue;
    const after = checkHookQuality([{ id, title: copy.title, description: copy.description }], { lang, surface: "publish" });
    if (after.length > 0 && after[0].codes.length >= flag.codes.length) continue;
    const keepAngle = !flag.codes.includes("angle-repeat");
    base.set(id, {
      ...copy,
      ...(keepAngle && prev.angle ? { angle: prev.angle } : {}),
      ...(keepAngle && prev.ctaType ? { ctaType: prev.ctaType } : {}),
      ...(keepAngle && prev.cta ? { cta: prev.cta } : {}),
    });
  }
}

/**
 * 批量生成发布文案。fail-open:失败返回 null(调用方据此不写文案文件);
 * 上游取消原样上抛。
 *
 * 生成完先本地质检(hook-quality):标题套话开头/超长/带话题标签/命中风险词/
 * 整批重复或角度撞车 → **一次**返工调用,只把点名条目送去重写,只有真变好的
 * 结果才覆盖。返工与首轮共用同一个 deadline,总时长仍受 PUBLISH_TIMEOUT_MS
 * 约束(不是翻倍);返工失败、超时、输出是垃圾,都退回首轮结果。
 */
export async function generatePublishCopies(
  sources: PublishSource[],
  lang: AppLang,
  llm: LlmConfig,
  chat: PublishChatFn,
  signal?: AbortSignal
): Promise<Map<number, PublishCopy> | null> {
  if (sources.length === 0) return null;
  try {
    const timeout = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const content = await chat(llm, publishSystemPrompt(lang), publishUserPrompt(sources, lang), combined);
    const validIds = new Set(sources.map((s) => s.id));
    const parsed = parsePublishCopies(content, validIds);
    if (parsed.size === 0) return null;

    const flags = checkHookQuality(
      [...parsed].map(([id, c]) => ({ id, title: c.title, description: c.description, angle: c.angle })),
      { lang, surface: "publish" }
    );
    if (flags.length === 0) return parsed; // 干净的一批不花第二次调用

    try {
      const flagged = new Set(flags.map((f) => f.id));
      const again = await chat(
        llm,
        publishSystemPrompt(lang) + REWORK_HEADER[lang],
        publishRewritePrompt(sources.filter((s) => flagged.has(s.id)), parsed, flags, lang),
        combined
      );
      mergeRewrites(parsed, parsePublishCopies(again, flagged), flags, lang);
    } catch (e) {
      if (signal?.aborted) throw e; // 上游取消照旧上抛
      // 返工失败不影响首轮成果(fail-open)
    }
    return parsed;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/**
 * .post.txt 内容:标题 + 空行 + 话题 + 空行 + 简介(CTA 缀在简介后一行),直接全选复制。
 * AIGC 通用提醒跟随界面语言(lang,缺省 zh 以保持 CLI/MCP 输出不变),不跟随
 * 成片语言——它是写给发布者看的操作提示,不是观众读的文案。
 */
export function postTextFile(copy: PublishCopy, aigc = false, lang: AppLang = "zh"): string {
  const parts = [copy.title];
  if (copy.hashtags.length > 0) parts.push(copy.hashtags.join(" "));
  const body = [copy.description, copy.cta ?? ""].filter(Boolean).join("\n");
  if (body) parts.push(body);
  // 开了 AIGC 标识:通用提醒(各平台的具体操作提示在发布包 manifest/文案里)
  if (aigc) parts.push(AIGC_POST_NOTE[lang]);
  return parts.join("\n\n") + "\n";
}
