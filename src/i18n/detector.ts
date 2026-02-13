import type { SupportedLanguage } from "../magi/types.ts";

export function detectLanguage(text: string): SupportedLanguage {
  const korean = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const japanese = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  const english = (text.match(/[a-zA-Z]/g) || []).length;

  const total = korean + japanese + english;
  if (total === 0) return "en";

  if (korean >= japanese && korean >= english) return "ko";
  if (japanese >= korean && japanese >= english) return "ja";
  return "en";
}
