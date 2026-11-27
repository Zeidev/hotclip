/**
 * 钩子/标题的「怎么写」教义(纯数据 + 字符串,零依赖、零 API)。
 *
 * 与 prompt.ts 里既有的「怎么挑开头句」教义分工不同:那一段管的是 stage-1
 * 的 hook 字段(逐字取自逐句稿,是选择问题);这里管的是模型**自己写**出来的
 * 文本——stage-1 的 title、stage-2 的 teaser、发布文案的 title、变体的
 * 标题卡/悬念句。写出来的东西才可能空、才可能浮、才可能不兑现,所以这里
 * 讲的是「留白、具体、前三个字、许诺必须兑现」这套写法。
 *
 * 三语各自原生(土耳其语的钩子句式不是英文的翻译),英文/土耳其语块里不许
 * 出现中文(CJK 泄漏是品类判据踩过的坑)。块里刻意不出现时长档位字符串
 * ("8~40 秒"/"8–40 seconds"/"8–40 saniye")——highlightSystemPrompt 会按
 * 档位对这些字符串做 replace,教义块混进去会被误伤。
 *
 * 质检口径见 hook-quality.ts:教义说什么,那边就查什么。
 */
import type { AppLang } from "../shared/ui-lang";

/** 一种让观众非点不可的写法(名/规则/正反例都是三语原生)。 */
export interface HookMechanic {
  /** 稳定 id(CJK 单字),只给代码用,不翻译。 */
  id: string;
  name: Record<AppLang, string>;
  rule: Record<AppLang, string>;
  fix: { bad: Record<AppLang, string>; good: Record<AppLang, string> };
}

/** 五种最稳的钩子机制(反常识/停止式/提问/结果反差/痛点点名)。 */
export const HOOK_MECHANICS: HookMechanic[] = [
  {
    id: "反",
    name: { zh: "反常识打脸", tr: "Karşı-sezgi", en: "Counter-intuitive reveal" },
    rule: {
      zh: "先说出大家的默认认知,再一句翻掉它:你以为 X,其实 Y。",
      tr: "Önce herkesin doğru sandığını söyle, sonra tek cümlede ters çevir: herkes X sanıyor, gerçek şu ki Y.",
      en: "State the default belief first, then overturn it in one line: everyone blames X, it is actually Y.",
    },
    fix: {
      bad: {
        zh: "今天聊聊吸水性问题",
        tr: "Su çekme problemi hakkında konuşalım",
        en: "Let's talk about the absorbency problem",
      },
      good: {
        zh: "半杯水都不渗,这张纸凭什么",
        tr: "Herkes şampuanı suçluyor, sebep tamamen başka",
        en: "Half a cup and it never leaks — so what is this paper?",
      },
    },
  },
  {
    id: "停",
    name: { zh: "停止式命令", tr: "Bırakma emri", en: "Stop-doing imperative" },
    rule: {
      zh: "直接点名一个正在做错的动作,让它有代价:别再这样 X 了。",
      tr: "Yanlış yapılan tek bir hareketi doğrudan adresle ve bedelini söyle: bunu böyle yapmayı bırak.",
      en: "Name one wrong action directly and give it a cost: stop doing X like that.",
    },
    fix: {
      bad: {
        zh: "搬箱子的几个建议",
        tr: "Kutu kaldırma hakkında öneriler",
        en: "A few tips about lifting boxes",
      },
      good: {
        zh: "别再这样弯腰搬箱子了,腰就是这么废的",
        tr: "Kutuyu böyle kaldırmayı bırak, belin tam bu yüzden ağrıyor",
        en: "Stop lifting boxes like this — that is how your back goes",
      },
    },
  },
  {
    id: "問",
    name: { zh: "直接提问", tr: "Doğrudan soru", en: "Direct question" },
    rule: {
      zh: "问观众自己正在遭遇、但说不出原因的事:为什么你总是 X?",
      tr: "İzleyicinin yaşadığı ama sebebini bilmediği şeyi sor: neden senin X hiç Y olmuyor?",
      en: "Ask about something the viewer lives with but cannot explain: why does your X never Y?",
    },
    fix: {
      bad: {
        zh: "涨粉经验分享",
        tr: "Kanal büyütme deneyimim",
        en: "My experience growing a channel",
      },
      good: {
        zh: "为什么你发了 100 条还是没人看",
        tr: "Neden 100 video yükledin de hâlâ kimse izlemiyor?",
        en: "Why does nobody watch after 100 uploads?",
      },
    },
  },
  {
    id: "差",
    name: { zh: "结果反差", tr: "Sonuç farkı", en: "Result gap" },
    rule: {
      zh: "给一个和常识不符的具体结果,数字必须来自片子本身:我用 X 做到了 Y。",
      tr: "Beklentiyle çelişen somut bir sonuç ver, sayı klibin kendisinden gelsin: X yapmadan Y'ye ulaştım.",
      en: "Give a concrete result that fights expectation — the number comes from the clip: I did Y without X.",
    },
    fix: {
      bad: {
        zh: "我的减脂经历",
        tr: "Kilo verme sürecim",
        en: "My weight-loss journey",
      },
      good: {
        zh: "不戒主食,8 周掉了 6 斤",
        tr: "Ekmeği kesmeden 8 haftada 6 kilo verdim",
        en: "8 weeks, 6 kg, bread never cut",
      },
    },
  },
  {
    id: "痛",
    name: { zh: "痛点点名", tr: "Dert noktası", en: "Pain-point callout" },
    rule: {
      zh: "把观众的具体处境说出来,让他觉得这句话是写给自己的:你是不是也…",
      tr: "İzleyicinin somut durumunu söyle, cümlenin kendisine yazıldığını hissetsin: sen de ... mı yaşıyorsun?",
      en: "Say the viewer's exact situation so the line feels written for them: are you also the one who...?",
    },
    fix: {
      bad: {
        zh: "头发爱出油的问题",
        tr: "Yağlı saç problemi",
        en: "The oily-hair problem",
      },
      good: {
        zh: "早上刚洗,下午就油?问题不在洗发水",
        tr: "Sabah yıkayıp akşam yağlananlardan mısın? Suç şampuanda değil",
        en: "Washed this morning, oily by noon? It is not the shampoo",
      },
    },
  },
];

/** 每条机制的行标签(「反面/正面」这类),随语言。 */
const FIX_LABELS: Record<AppLang, { bad: string; good: string }> = {
  zh: { bad: "反面", good: "正面" },
  tr: { bad: "Kötü", good: "İyi" },
  en: { bad: "Bad", good: "Good" },
};

const HEADING: Record<AppLang, string> = {
  zh: "【钩子与标题:让人非点不可的写法】",
  tr: "【Kanca ve başlık: nasıl yazılır】",
  en: "【Hooks and titles: how to write them】",
};

/** 四条总原则(每语一段,原生表述)。 */
const PRINCIPLES: Record<AppLang, string[]> = {
  zh: [
    "只开一个坑:标题/悬念句要抛出一个观众想补上的空缺,答案留到片子里。答案写进标题,点开就没有理由了。",
    "具体压过抽象:片内的具体名词/数字/时间进标题(「3 个动作」「第 2 天」「8 周」);「一些方法」「很多人」这类词等于没说。",
    "前三个字定生死:滑走只在一瞬间,最强的词放最前;开头不许是问候语或「本视频」。",
    "只许诺片里真有的:标题应下的承诺,片内必须兑现(兑不了改标题,不改片子);片里没有的数字、名次、效果一律不写。",
  ],
  tr: [
    "Tek bir boşluk aç: başlık, izleyicinin kapatmak isteyeceği bir boşluk bıraksın; cevap klipte kalsın. Cevabı başlığa yazarsan tıklamaya sebep kalmaz.",
    "Somut, soyutun önünde: klipteki somut isim/sayı/zaman başlığa girsin (\"3 adım\", \"ikinci gün\", \"8 hafta\"); \"bazı yöntemler\", \"birçok kişi\" hiçbir şey söylemez.",
    "İlk üç kelime her şeyi belirler: kaydırma bir anda oluyor, en güçlü sözcük başa gelsin; başlık selamla ya da \"bu videoda\" ile başlamasın.",
    "Yalnız klipte olanı vaat et: başlığın verdiği söz klip içinde ödensin (ödenmiyorsa başlık değişir, klip değil); klipte geçmeyen sayı, sıralama, sonuç yazma.",
  ],
  en: [
    "Open exactly one gap: the title/hook line leaves a hole the viewer wants closed, and the answer stays in the clip. Put the answer in the title and there is no reason left to click.",
    "Concrete beats abstract: put the clip's own nouns/numbers/times in the title (\"3 moves\", \"day two\", \"8 weeks\"); \"some methods\" and \"many people\" say nothing.",
    "The first three words decide it: the swipe is instant, so the strongest word goes first; never open with a greeting or \"in this video\".",
    "Promise only what the clip really has: whatever the title promises must be paid inside the clip (if it is not, change the title, not the clip); never write a number, ranking or result the clip does not contain.",
  ],
};

/**
 * 必需成分:每条标题都要同时有锚点与转折。只有机制清单时,模型容易挑一条机制
 * 却写成中性陈述——这里把「缺哪一半」直接点破(清单 vs 空话)。
 */
const REQUIRED_PARTS: Record<AppLang, string> = {
  zh: "每条标题必须同时含两种成分:①锚点——片内的具体数字、专名或逐字引用,缺了就不可能有说服力;②转折——一个反差、代价或提问,让读者想补上那个空。只有锚点没有转折是清单,只有转折没有锚点是空话。",
  tr: "Her başlıkta iki unsur birden olmalı: ①çapa — klipten somut bir sayı, özel isim ya da birebir alıntı; olmadan inandırıcı olmaz. ②dönüş — bir karşıtlık, bedel ya da soru, izleyici o boşluğu kapatmak istesin. Çapa var dönüş yok ise liste olur; dönüş var çapa yok ise laf kalabalığı.",
  en: "Every title must carry two parts at once: (1) an anchor — a concrete number, proper name or verbatim quote from the clip, without which it cannot convince; (2) a turn — a contrast, a cost or a question that leaves a hole the reader wants closed. Anchor without turn is a list; turn without anchor is hot air.",
};

/**
 * 禁止形状:比原则更硬——写出来就自毁的几种句形。本地质检给的
 * topic-label / no-anchor / flat-close 判定,查的就是这几行说的东西。
 */
const BANNED_SHAPES: Record<AppLang, string[]> = {
  zh: [
    "话题标签式:「XX 是什么」「XX 那些事」「XX 的几点想法」——读者一看就知道是科普条目,不是有人非说不可的话。",
    "模板问句:「XX 有用吗」「XX 怎么选」这类谁都能问、答案又不在片里的问题。",
    "两句中性陈述并排:「今天去了 A,也去了 B」——没有转折、代价或反差。",
    "过程描述收尾:以「我在做 X」「X 会发生」这类平铺收尾,读完没有要补上的空。",
    "无锚点:片里有具体数字、名字、时间,标题却一个都不写。",
  ],
  tr: [
    "Konu etiketi: \"X nedir\", \"X hakkında\", \"X ile ilgili birkaç şey\" — izleyici bunun bir ansiklopedi maddesi olduğunu anlar, birinin söylemek zorunda olduğu bir söz değil.",
    "Kalıp soru: \"X işe yarar mı\", \"X nasıl seçilir\" gibi herkesin sorabileceği, cevabı klipte olmayan sorular.",
    "Yan yana iki nötr cümle: \"Bugün A'ya gittim, B'ye de uğradım\" — dönüş, bedel ya da karşıtlık yok.",
    "Süreç tarifi kapanışı: \"X yapıyorum\", \"X oluyor\" diye düz bitirmek — okurken kapatılacak bir boşluk kalmıyor.",
    "Çapasız başlık: klipte somut sayı, isim, zaman var ama başlıkta hiçbiri geçmiyor.",
  ],
  en: [
    "Topic label: \"What X is\", \"A few thoughts on X\" — the reader sees an encyclopedia entry, not a line someone had to say.",
    "Template question: \"Does X work\", \"How do you pick X\" — anyone could ask it and the clip does not answer it.",
    "Two neutral statements in a row: \"I went to A today, and also to B\" — no turn, no cost, no contrast.",
    "Process description ending: trailing off with \"I am doing X\" or \"X happens\" leaves nothing to close.",
    "No anchor: the clip has a concrete number, name or time and the title uses none of them.",
  ],
};

/** 自检一行:交答案前的最后一道自我审稿。 */
const SELF_CHECK: Record<AppLang, string> = {
  zh: "先想三个不同机制的标题,挑最强的那条交上去;把你写的那条念一遍——听起来像新闻标题或目录条目,就重写。",
  tr: "Önce üç ayrı yolla üç başlık kur, en güçlüsünü ver; seçtiğini sesli oku — haber başlığı ya da içindekiler maddesi gibi geliyorsa yeniden yaz.",
  en: "Draft three titles by three different routes and submit the strongest; read yours aloud — if it sounds like a news headline or a table of contents, rewrite it.",
};

/** 禁令一行(平台风险与低级失分)。 */
const BANS: Record<AppLang, string> = {
  zh: "禁止:emoji 堆、标题里塞话题标签(话题有单独字段)、以问候语开头;不写疗效/收益/保证类词与「最后一天」这类虚假紧迫感。",
  tr: "Yasak: emoji yığmak, başlığa hashtag koymak (etiketin kendi alanı var), selamla başlamak; sağlık, kazanç, garanti iddiası ve \"en iyi / son gün\" gibi sözler yok.",
  en: "Banned: emoji piles, hashtags inside the title (they have their own field), greeting openers; no health, earnings or guarantee claims and no fake urgency such as \"best ever\" or \"last day\".",
};

/** 长度口径一行(具体数字在各字段说明里,这里只强调严格)。 */
const LENGTHS: Record<AppLang, string> = {
  zh: "长度按对应字段说明的硬上限,超过一个字也算不合格——下笔前自己数一遍。",
  tr: "Uzunluk, ilgili alanın açıklamasındaki katı sınırdır; bir karakter fazlası bile kabul edilmez — yazmadan önce say.",
  en: "Length is the hard cap in the field description: one character over is still a miss — count it before you answer.",
};

const SECTION_HEADER: Record<AppLang, string> = {
  zh: "写法(五选一,每个标题只走一条):",
  tr: "Yazma yolları (beşinden birini seç; her başlık tek yol izler):",
  en: "Writing routes (pick one; each title follows a single route):",
};

/** 禁止句形的行标题(与上面的必需成分成对出现)。 */
const BANNED_SHAPE_HEADER: Record<AppLang, string> = {
  zh: "禁止的句形(命中任何一条就等于没写):",
  tr: "Yasak şekiller (aşağıdakilerden biri varsa yazılmamış sayılır):",
  en: "Banned shapes (any one of these means it is not written yet):",
};

/** 自检行的标签。 */
const SELF_CHECK_HEADER: Record<AppLang, string> = {
  zh: "【交答案前】",
  tr: "【Teslim etmeden önce】",
  en: "【Before you answer】",
};

function mechanicLine(lang: AppLang, m: HookMechanic, index: number): string {
  const L = FIX_LABELS[lang];
  return [
    `${index + 1}. ${m.name[lang]} — ${m.rule[lang]}`,
    `   ${L.bad}: ${m.fix.bad[lang]}`,
    `   ${L.good}: ${m.fix.good[lang]}`,
  ].join("\n");
}

const SECTIONS: Record<AppLang, string> = {
  zh: buildSection("zh"),
  tr: buildSection("tr"),
  en: buildSection("en"),
};

function buildSection(lang: AppLang): string {
  return [
    `\n\n${HEADING[lang]}`,
    ...PRINCIPLES[lang],
    REQUIRED_PARTS[lang],
    SECTION_HEADER[lang],
    ...HOOK_MECHANICS.map((m, i) => mechanicLine(lang, m, i)),
    BANNED_SHAPE_HEADER[lang],
    ...BANNED_SHAPES[lang],
    `${SELF_CHECK_HEADER[lang]}${SELF_CHECK[lang]}`,
    BANS[lang],
    LENGTHS[lang],
  ].join("\n");
}

/**
 * 完整写法教义,追加到系统提示词尾部(stage-1 / moment / 发布文案 / 变体)。
 * 纯字符串拼接,无副作用;同一语言每次返回同一段文本。
 */
export function hookCraftSection(lang: AppLang): string {
  return SECTIONS[lang];
}

/** 写在画面上的一句悬念(teaser/标题卡):短,只讲写法要点。 */
const ON_SCREEN: Record<AppLang, string> = {
  zh: "【悬念句写法】只挖一个坑,答案留在片里;句子里必须有一个片内的锚点(具体数字/专名/逐字引用)加一个转折(反差/代价/提问);不许写成话题标签、模板问句(「XX 有用吗」)或两句中性陈述;前三个字必须抓人,不许以「本视频」「大家好」开头;不剧透结局、不写疗效/收益/绝对化用语;许诺必须在片内兑现,兑不了就换句子。",
  tr: "【Merak cümlesi nasıl yazılır】 Tek bir boşluk aç, cevabı klibe bırak; cümlede klipten bir çapa (somut sayı/özel isim/birebir alıntı) ve bir dönüş (karşıtlık/bedel/soru) bulunsun; konu etiketi, kalıp soru (\"X işe yarar mı\") ya da yan yana iki nötr cümle olmasın; ilk üç kelime tutmalı, \"bu videoda\" ya da \"merhaba\" ile başlamasın; sonu spoiler vermesin, sağlık/kazanç/garanti ve \"en iyi\" tarzı sözler olmasın; vaat klip içinde ödenmeli, ödenmiyorsa cümle değişir.",
  en: "【How to write the on-screen hook】 Open one gap and leave the answer to the clip; the line needs an anchor from the clip (a concrete number, proper name or verbatim quote) plus a turn (contrast, cost or question); never a topic label, a template question (\"does X work\") or two neutral statements in a row; the first three words must land, never open with \"in this video\" or a greeting; no spoiler, no health/earnings/absolute wording; the promise must be paid inside the clip or the line changes.",
};

/**
 * 短版写法要点(teaser 与变体包装用;完整教义塞进评审提示词会挤掉评审本身)。
 */
export function onScreenHookRules(lang: AppLang): string {
  return ON_SCREEN[lang];
}
