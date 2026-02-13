import type { SupportedLanguage, Verdict } from "../magi/types.ts";

import en from "./en.json" with { type: "json" };
import ja from "./ja.json" with { type: "json" };
import ko from "./ko.json" with { type: "json" };

export type MessageKey = keyof typeof en;

// deno-lint-ignore no-explicit-any
const bundles: Record<SupportedLanguage, Record<string, any>> = { en, ja, ko };

function applyVars(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  let result = text;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replaceAll(`{${k}}`, String(v));
  }
  return result;
}

export function t(
  lang: SupportedLanguage,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const val = bundles[lang]?.[key] ?? bundles.en[key] ?? key;
  return applyVars(String(val), vars);
}

const VERDICT_KEYS: Record<Verdict, MessageKey> = {
  APPROVE: "verdictApprove",
  DENY: "verdictDeny",
  CONDITIONAL: "verdictConditional",
  REFUSE: "verdictRefuse",
} as Record<Verdict, MessageKey>;

export function tVerdict(lang: SupportedLanguage, verdict: Verdict): string {
  return t(lang, VERDICT_KEYS[verdict]);
}

export function tRandom(
  lang: SupportedLanguage,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const val = bundles[lang]?.[key] ?? bundles.en[key];
  if (Array.isArray(val)) {
    const picked = val[Math.floor(Math.random() * val.length)];
    return applyVars(String(picked), vars);
  }
  return applyVars(String(val ?? key), vars);
}
