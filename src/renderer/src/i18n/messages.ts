/**
 * Locale registry + resolver.
 * Adding a language = one file in ./locales + one REGISTRY entry. Nothing else.
 * zh is the source of truth; missing keys in any locale fall back to en, then zh —
 * an English reader never sees Chinese, and a Turkish reader gets English before Chinese.
 */
import { zh } from "./locales/zh";
import { en } from "./locales/en";
import { tr } from "./locales/tr";

/** All installed locales. Extend here (ja/ko/es/…) — UI picks this up automatically. */
export const REGISTRY = {
  zh: { label: "中文", dict: zh },
  en: { label: "English", dict: en },
  tr: { label: "Türkçe", dict: tr },
} as const;

export type Locale = keyof typeof REGISTRY;

/** zh defines the full key space; other locales may lag behind it. */
type Dict = { [ns: string]: { [key: string]: string } };

export const LOCALE_LIST = Object.keys(REGISTRY) as Locale[];

/**
 * Locale for main-process report text (the health check). Those strings are written
 * zh/en only, so any other UI locale reads English rather than falling back to Chinese.
 */
export function reportLocale(locale: Locale): "zh" | "en" {
  return locale === "zh" ? "zh" : "en";
}

/** Intl tag for dates and numbers, so a Turkish UI reads Turkish month names. */
export function intlLocale(locale: string): string {
  return locale === "zh" ? "zh-CN" : locale === "tr" ? "tr-TR" : "en-US";
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in REGISTRY;
}

/** Detect the initial locale: persisted choice first, then system language. */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem("hotclip-locale");
    if (isLocale(saved)) return saved;
  } catch {
    /* localStorage unavailable — fall through to system detection */
  }
  const sys = navigator.language?.toLowerCase() ?? "";
  for (const locale of LOCALE_LIST) {
    if (sys.startsWith(locale)) return locale;
  }
  return sys.startsWith("zh") ? "zh" : "en";
}

/**
 * Locale the UI persisted (the locale store writes this key). For non-React callers
 * that must produce a human-readable string right now — auto-named schemes and brand
 * presets are created in a store, and hardcoding Chinese there leaks zh into en/tr UI.
 */
export function storedLocale(): Locale {
  try {
    const saved = localStorage.getItem("hotclip-locale");
    if (isLocale(saved)) return saved;
  } catch {
    /* no storage — fall through */
  }
  return "en";
}

/** translate() bound to the persisted locale, for non-React callers. */
export function translateNow(namespace: string, key: string, params?: Record<string, string | number>): string {
  return translate(storedLocale(), namespace, key, params);
}

/** Resolve namespace.key in the given locale; falls back to en, then zh, then the key itself. */
export function translate(
  locale: Locale,
  namespace: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = REGISTRY[locale].dict as Dict;
  const english = REGISTRY.en.dict as Dict;
  const source = REGISTRY.zh.dict as Dict;
  let text = dict[namespace]?.[key] ?? english[namespace]?.[key] ?? source[namespace]?.[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
