/**
 * 发布文案的结构化模板:8 种钩子角度 × 5 类 CTA(行动号召)。
 * 与其让 LLM 自由发挥「写个有钩子的标题」,不如把运营侧验证过的角度菜单
 * 摆出来让它选型——每条文案带上「用了哪个角度/哪类 CTA」的标签,可审计
 * 可改判,整批切片也不会千篇一律同一个套路。
 *
 * 纯数据 + 纯函数:改角度、加 CTA 只动表,不动逻辑。提示词菜单与
 * 违禁词 lint(content-lint.ts)呼应:紧迫感角度、商品 CTA 的提示里
 * 明确划掉会撞 lint 的说法,让模型别先写雷词再等人改。
 *
 * 三语齐备:菜单进提示词,必须与成片语言一致——中文菜单(带中文提示)
 * 只给中文稿用,tr/en 各走自己的一句解释。id 三语共用,回执不变。
 */
import type { AppLang } from "../shared/ui-lang";

/** 钩子角度 id(进 clips.json 与提示词,稳定不改)。 */
export type HookAngleId =
  | "question"
  | "suspense"
  | "contrast"
  | "number"
  | "pain"
  | "counter"
  | "identity"
  | "urgency";

interface HookAngle {
  id: HookAngleId;
  zh: string;
  tr: string;
  en: string;
  /** 提示词里的一句解释+示例形态(中文)。 */
  hintZh: string;
  hintTr: string;
  hintEn: string;
}

const HOOK_ANGLES: HookAngle[] = [
  {
    id: "question",
    zh: "提问式",
    tr: "soru",
    en: "question",
    hintZh: "直接抛观众关心的问题(「为什么你的×××总是不行?」)",
    hintTr: "doğrudan izleyicinin sorusunu sor (\"Neden seninki bir türlü olmuyor?\")",
    hintEn: "open with the audience's own question ('why does your ... never work?')",
  },
  {
    id: "suspense",
    zh: "悬念式",
    tr: "merak",
    en: "suspense",
    hintZh: "结论藏后半,先给悬念(「最后一步九成人都做错」)",
    hintTr: "sonucu ikinci yarıya sakla (\"Son adımı çoğu kişi yanlış yapıyor\")",
    hintEn: "withhold the payoff ('most people get the last step wrong')",
  },
  {
    id: "contrast",
    zh: "反差式",
    tr: "tezat",
    en: "contrast",
    hintZh: "前后/身份/预期的强反差(「同样的食材,差在这一步」)",
    hintTr: "öncesi/sonrası ya da beklentiyle sert tezat (\"Aynı malzeme, fark bu adımda\")",
    hintEn: "sharp before/after or expectation contrast",
  },
  {
    id: "number",
    zh: "数字盘点",
    tr: "sayı",
    en: "number",
    hintZh: "数字给确定感(「3 个方法」「5 个坑」)",
    hintTr: "sayı belirsizliği kaldırır (\"3 yöntem\", \"5 hata\")",
    hintEn: "numbers promise structure ('3 ways', '5 traps')",
  },
  {
    id: "pain",
    zh: "痛点共鸣",
    tr: "sorun",
    en: "pain",
    hintZh: "先说出观众正难受的事(「每天加班还是存不下钱」)",
    hintTr: "önce izleyicinin şu an çektiği derdi söyle (\"Her gün mesai, yine para birikmiyor\")",
    hintEn: "name the viewer's pain first",
  },
  {
    id: "counter",
    zh: "反常识",
    tr: "karşıt",
    en: "counter",
    hintZh: "推翻普遍认知(「越省钱越穷」)",
    hintTr: "yaygın inancı tersine çevir (\"Ne kadar tasarruf etsen o kadar yoksulsun\")",
    hintEn: "overturn common belief",
  },
  {
    id: "identity",
    zh: "身份代入",
    tr: "kimlik",
    en: "identity",
    hintZh: "点名人群让对的人停下(「如果你也是新手爸妈」)",
    hintTr: "izleyiciyi kimliğiyle çağır (\"Sen de yeni ebeveynsen\")",
    hintEn: "call out the audience by identity",
  },
  {
    id: "urgency",
    zh: "时效紧迫",
    tr: "aciliyet",
    en: "urgency",
    hintZh: "用真实时效驱动(政策/季节/版本变化);禁编造截止与「最后一天」式话术",
    hintTr: "yalnız gerçek güncellik kullan (mevzuat/sezon/sürüm değişikliği); uydurma son tarih ve \"son gün\" tarzı laf yok",
    hintEn: "real timeliness only (policy/season/version); never fabricate deadlines",
  },
];

/** CTA 类型 id(进 clips.json 与提示词,稳定不改)。 */
export type CtaTypeId = "follow" | "comment" | "share" | "save" | "product";

interface CtaType {
  id: CtaTypeId;
  zh: string;
  tr: string;
  en: string;
  hintZh: string;
  hintTr: string;
  hintEn: string;
}

const CTA_TYPES: CtaType[] = [
  {
    id: "follow",
    zh: "关注引导",
    tr: "takip",
    en: "follow",
    hintZh: "给关注的理由,预告下一条(「关注我,下期拆解×××」)",
    hintTr: "takip için sebep ver, sıradakini ima et (\"Takip et, bir sonraki videoda ...\")",
    hintEn: "give a reason to follow, tease the next video",
  },
  {
    id: "comment",
    zh: "评论互动",
    tr: "yorum",
    en: "comment",
    hintZh: "提问式收尾请观众站队/补充(「你是哪一种?评论区聊聊」)",
    hintTr: "soruyla bitir, izleyiciyi taraf tutmaya ya da eklemeye çağır (\"Sen hangisisin? Yorumlarda konuşalım\")",
    hintEn: "end with a question inviting comments",
  },
  {
    id: "share",
    zh: "转发分享",
    tr: "paylaşım",
    en: "share",
    hintZh: "指定转发对象(「转给那个总是×××的朋友」)",
    hintTr: "kime göndereceğini söyle (\"Hep ... yapan o arkadaşına gönder\")",
    hintEn: "name who to share it with",
  },
  {
    id: "save",
    zh: "收藏回看",
    tr: "kaydet",
    en: "save",
    hintZh: "步骤多/信息密的内容提示先收藏(「细节多,建议收藏慢慢看」),可加一句「更多同场内容看主页合集」——收藏率与合集是 2026 权重最高的两个入口",
    hintTr: "adımı çok ya da bilgisi yoğun içerikte kaydetmeyi öner, profil koleksiyonuna işaret edebilirsin — kaydetme ve koleksiyon 2026'nın en yüksek ağırlıklı iki girişi",
    hintEn: "dense how-to content: suggest saving for later, optionally point to the profile playlist/collection",
  },
  {
    id: "product",
    zh: "商品引导",
    tr: "ürün",
    en: "product",
    hintZh: "仅内容明显带货时用,站内组件口径(购物车/小黄车);禁站外导流与加微信类话术",
    hintTr: "yalnız içerik açıkça ticariyse, platform içi bileşenlerle (sepet); platform dışına yönlendirme ve mesajlaşma uygulamasına çekme yok",
    hintEn: "only for clearly commercial clips, in-platform components only; never funnel off-platform",
  },
];

const ANGLE_IDS = new Set<string>(HOOK_ANGLES.map((a) => a.id));
const CTA_IDS = new Set<string>(CTA_TYPES.map((c) => c.id));

export function isHookAngle(v: unknown): v is HookAngleId {
  return typeof v === "string" && ANGLE_IDS.has(v);
}

export function isCtaType(v: unknown): v is CtaTypeId {
  return typeof v === "string" && CTA_IDS.has(v);
}

/** 提示词用的角度菜单(中文每行「id=名:怎么用」,tr/en 每行「id = 怎么用」)。 */
export function hookAngleMenu(lang: AppLang): string {
  return HOOK_ANGLES.map((a) =>
    lang === "zh" ? `${a.id}=${a.zh}:${a.hintZh}` : `${a.id} = ${lang === "tr" ? a.hintTr : a.hintEn}`
  ).join("\n");
}

/** 提示词用的 CTA 菜单。 */
export function ctaMenu(lang: AppLang): string {
  return CTA_TYPES.map((c) =>
    lang === "zh" ? `${c.id}=${c.zh}:${c.hintZh}` : `${c.id} = ${lang === "tr" ? c.hintTr : c.hintEn}`
  ).join("\n");
}

/** 角度 id → 人类可读名(回执/UI);未知 id 原样返回。 */
export function hookAngleLabel(id: string, lang: AppLang): string {
  const a = HOOK_ANGLES.find((x) => x.id === id);
  return a ? a[lang] : id;
}

/** CTA 类型 id → 人类可读名;未知 id 原样返回。 */
export function ctaTypeLabel(id: string, lang: AppLang): string {
  const c = CTA_TYPES.find((x) => x.id === id);
  return c ? c[lang] : id;
}
