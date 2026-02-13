import { log } from "./logger.ts";
import type { SupportedLanguage } from "./magi/types.ts";

export interface UserPref {
  fixedLang?: SupportedLanguage;
  detectedLang?: SupportedLanguage;
}

let kv: Deno.Kv;

/** Lazy — read after .env is loaded. */
function cooldownMs(): number {
  return (parseInt(Deno.env.get("COOLDOWN_SECONDS") || "3600")) * 1000;
}

/**
 * Initialize Deno KV. Must be called once before any storage operations.
 * Uses DATA_DIR env var for persistent volume mount; otherwise default location.
 */
export async function initStorage(): Promise<void> {
  const dataDir = Deno.env.get("DATA_DIR");
  kv = await Deno.openKv(dataDir ? `${dataDir}/magi.db` : undefined);
}

// ── User Preferences ────────────────────────────────────────────

export async function getUserPref(
  userId: number,
): Promise<UserPref | undefined> {
  const entry = await kv.get<UserPref>(["user", userId, "pref"]);
  return entry.value ?? undefined;
}

export async function setUserPref(
  userId: number,
  pref: UserPref,
): Promise<void> {
  const clean: UserPref = {};
  if (pref.fixedLang) clean.fixedLang = pref.fixedLang;
  if (pref.detectedLang) clean.detectedLang = pref.detectedLang;
  await kv.set(["user", userId, "pref"], clean);
}

// ── Query Counter (atomic, survives restarts) ───────────────────

export async function getQueryCount(): Promise<number> {
  const entry = await kv.get(["stats", "queryCount"]);
  if (entry.value instanceof Deno.KvU64) return Number(entry.value.value);
  // Fallback for legacy plain-number entries
  if (typeof entry.value === "number") return entry.value;
  return 0;
}

export async function incrementQueryCount(): Promise<void> {
  await kv.atomic().sum(["stats", "queryCount"], 1n).commit();
}

// ── Per-user Cooldown ───────────────────────────────────────────

export async function getLastRequest(
  userId: number,
): Promise<number | undefined> {
  const entry = await kv.get<number>(["user", userId, "lastRequest"]);
  return entry.value ?? undefined;
}

export async function setLastRequest(userId: number): Promise<void> {
  await kv.set(["user", userId, "lastRequest"], Date.now(), {
    expireIn: cooldownMs() * 2,
  });
}

export function getCooldownMs(): number {
  return cooldownMs();
}

// ── User Context (compressed conversation memory) ────────────────

export interface UserContext {
  summary: string;
  updatedAt: number;
}

export async function getUserContext(userId: number): Promise<UserContext | null> {
  const entry = await kv.get<UserContext>(["user", userId, "context"]);
  return entry.value ?? null;
}

export async function setUserContext(userId: number, ctx: UserContext): Promise<void> {
  await kv.set(["user", userId, "context"], ctx);
}

// ── Rate Limit Persistence ──────────────────────────────────────

/** Fire-and-forget save of header-based rate limit data. */
export function saveRateLimitInfo(model: string, data: unknown): void {
  kv.set(["ratelimit", model, "info"], data).catch((err) =>
    log.debug("storage", "Rate limit info save failed", { model, error: err instanceof Error ? err.message : String(err) })
  );
}

/** Fire-and-forget save of local RPM sliding window timestamps. */
export function saveRpmWindow(model: string, timestamps: number[]): void {
  kv.set(["ratelimit", model, "rpm"], timestamps).catch((err) =>
    log.debug("storage", "RPM window save failed", { model, error: err instanceof Error ? err.message : String(err) })
  );
}

/** Fire-and-forget save of local TPD (Tokens Per Day) accumulator. */
export function saveTpdTracking(model: string, data: unknown): void {
  kv.set(["ratelimit", model, "tpd"], data).catch((err) =>
    log.debug("storage", "TPD tracking save failed", { model, error: err instanceof Error ? err.message : String(err) })
  );
}

/** Load all persisted rate limit entries from KV. */
export async function loadAllRateLimits(): Promise<
  Array<{ model: string; kind: string; value: unknown }>
> {
  const results: Array<{ model: string; kind: string; value: unknown }> = [];
  const entries = kv.list({ prefix: ["ratelimit"] });
  for await (const entry of entries) {
    if (entry.key.length !== 3) continue;
    results.push({
      model: entry.key[1] as string,
      kind: entry.key[2] as string,
      value: entry.value,
    });
  }
  return results;
}

// ── Utility ─────────────────────────────────────────────────────

export function formatRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
