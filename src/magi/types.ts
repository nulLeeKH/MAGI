export type Verdict = "APPROVE" | "DENY" | "CONDITIONAL" | "REFUSE";
export type PersonaName = "MELCHIOR-1" | "BALTHASAR-2" | "CASPER-3";
export type SupportedLanguage = "en" | "ja" | "ko";

export interface PersonaConfig {
  name: PersonaName;
  model: string;
  fallbackModels: string[];
  emergencyModel: string;
  temperature: number;
  systemPrompt: string;
}

export interface PersonaResponse {
  persona: PersonaName;
  content: string;
  verdict: Verdict;
  model: string;
  latencyMs: number;
  error?: string;
}

export interface MagiDeliberation {
  question: string;
  approvalCondition: string;
  searchContext: string | null;
  searchFailed: boolean;
  imageContext: string | null;
  fileContext: string | null;
  userContext: string | null;
  language: SupportedLanguage;
  melchior: PersonaResponse;
  balthasar: PersonaResponse;
  casper: PersonaResponse;
}

export type DeliberationResult = "approved" | "denied" | "conditional" | "noConsensus";

/** Majority-rule deliberation result from three MAGI core verdicts. */
export function computeDeliberationResult(d: MagiDeliberation): DeliberationResult {
  const verdicts = [d.melchior.verdict, d.balthasar.verdict, d.casper.verdict];
  const valid = verdicts.filter((v) => v !== "REFUSE");
  const approves = valid.filter((v) => v === "APPROVE").length;
  const denies = valid.filter((v) => v === "DENY").length;
  const conditionals = valid.filter((v) => v === "CONDITIONAL").length;
  if (approves >= 2) return "approved";
  if (denies >= 2) return "denied";
  if (approves + conditionals >= 2) return "conditional";
  return "noConsensus";
}
