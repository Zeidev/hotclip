/**
 * Language of the artifacts the app writes for the *creator to read* — the AIGC
 * mark burned into the picture, the notes in a publish-pack manifest, the
 * reminder appended to .post.txt.
 *
 * These follow the UI locale, not the transcript: they are instructions to the
 * person publishing, not copy the audience will ever see. Publish copy
 * (title/hashtags/CTA) is the opposite case and follows the transcript's
 * language — see `promptLanguage` in core/highlight/prompt.ts.
 *
 * Only three languages exist. A missing locale reads Chinese, which keeps CLI
 * and MCP output (they pass no locale) byte-identical to before this module.
 */
export type AppLang = "zh" | "tr" | "en";

/** Alias kept for the UI-facing call sites, which is where this started. */
export type UiLang = AppLang;

export function uiLang(locale: unknown): UiLang {
  if (locale === "tr") return "tr";
  if (locale === "en") return "en";
  return "zh";
}

/**
 * The mark drawn over the picture for the whole clip. Chinese keeps the wording
 * its own regulation asks for; the other two say what TikTok/Shorts/Reels
 * expect a viewer to read.
 */
export const AIGC_BADGE_TEXT: Record<UiLang, string> = {
  zh: "AI 生成",
  tr: "AI ile üretildi",
  en: "AI-generated",
};

/**
 * Generic AIGC reminder appended to .post.txt. The per-platform wording (which
 * switch to flip, where) lives in platform-specs.ts — this is the line for a
 * creator who just needs the reminder.
 */
export const AIGC_POST_NOTE: Record<UiLang, string> = {
  zh: "【AIGC 标注】发布时按平台要求勾选 AI 生成内容声明(未标注最高罚则为封号)",
  tr: "[AIGC beyanı] Yayınlarken platformun istediği AI içerik beyanını işaretle; beyan edilmeyen içerik hesabın kapanmasına kadar gidebilir.",
  en: "[AIGC label] Tick the AI-generated-content declaration the platform asks for; an undeclared clip can cost you the account.",
};
