/**
 * Groq API rate limit tracking with KV persistence.
 *
 * Header mapping (asymmetric):
 *   x-ratelimit-*-requests → RPD (Requests Per Day)
 *   x-ratelimit-*-tokens   → TPM (Tokens Per Minute)
 *
 * RPM and TPD are NOT exposed in headers — RPM is tracked locally
 * via a sliding window; TPD limits are stored for reference only.
 *
 * All data is persisted to Deno KV so RPD (daily) data survives restarts.
 * TPM and RPM data is also persisted but will naturally expire via
 * dimensionUsage() stale checks / sliding window pruning.
 */

import { log } from "../logger.ts";
import {
  loadAllRateLimits,
  saveRateLimitInfo,
  saveRpmWindow,
} from "../storage.ts";
import { MODELS } from "./personas.ts";

export interface RateLimitInfo {
  /** Requests Per Day — from x-ratelimit-*-requests headers */
  rpdLimit: number;
  rpdRemaining: number;
  rpdResetAt: number;
  /** Tokens Per Minute — from x-ratelimit-*-tokens headers */
  tpmLimit: number;
  tpmRemaining: number;
  tpmResetAt: number;
  updatedAt: number;
}

export interface LoadInfo {
  tpm: number; // -1 if unknown/stale
  rpm: number; // -1 if unknown/stale
  rpd: number; // -1 if unknown/stale
}

const store = new Map<string, RateLimitInfo>();

/** Known rate limits per model from Groq docs (not available via headers). */
const MODEL_LIMITS: Record<string, { rpm: number; tpd: number }> = {
  [MODELS.GPT_OSS_120B]:    { rpm: 30, tpd: 200_000 },
  [MODELS.KIMI_K2]:         { rpm: 60, tpd: 300_000 },
  [MODELS.KIMI_K2_0905]:    { rpm: 60, tpd: 300_000 },
  [MODELS.LLAMA4_SCOUT]:    { rpm: 30, tpd: 500_000 },
  [MODELS.LLAMA4_MAVERICK]: { rpm: 30, tpd: 500_000 },
  [MODELS.LLAMA33_70B]:     { rpm: 30, tpd: 100_000 },
  [MODELS.LLAMA31_8B]:      { rpm: 30, tpd: 500_000 },
  [MODELS.QWEN3_32B]:       { rpm: 60, tpd: 500_000 },
  [MODELS.COMPOUND]:        { rpm: 30, tpd: Infinity },
  [MODELS.COMPOUND_MINI]:   { rpm: 30, tpd: Infinity },
};

// ── RPM Sliding Window ──────────────────────────────────────────

/** Per-model request timestamps for local RPM tracking. */
const rpmWindows = new Map<string, number[]>();
const RPM_WINDOW_MS = 60_000;

/**
 * Record a request to a model. Call BEFORE the API call is made.
 * Prunes timestamps older than 60 s.
 */
export function recordModelRequest(model: string): void {
  const now = Date.now();
  const cutoff = now - RPM_WINDOW_MS;
  const timestamps = rpmWindows.get(model) ?? [];
  const pruned = timestamps.filter((ts) => ts > cutoff);
  pruned.push(now);
  rpmWindows.set(model, pruned);
  saveRpmWindow(model, pruned);
}

/** RPM usage as a percentage based on the local sliding window. */
function rpmUsagePercent(model: string): number {
  const limits = MODEL_LIMITS[model];
  if (!limits) return -1;
  if (!rpmWindows.has(model)) return -1; // never tracked
  const now = Date.now();
  const cutoff = now - RPM_WINDOW_MS;
  const timestamps = rpmWindows.get(model)!;
  const recent = timestamps.filter((ts) => ts > cutoff);
  rpmWindows.set(model, recent); // prune while we're here
  return (recent.length / limits.rpm) * 100;
}

// ── KV Persistence ──────────────────────────────────────────────

/**
 * Load persisted rate limit data from KV into memory.
 * Must be called after initStorage().
 */
export async function initRateLimits(): Promise<void> {
  const entries = await loadAllRateLimits();
  let infoCount = 0, rpmCount = 0;
  for (const { model, kind, value } of entries) {
    if (kind === "info" && value) {
      store.set(model, value as RateLimitInfo);
      infoCount++;
    } else if (kind === "rpm" && Array.isArray(value)) {
      rpmWindows.set(model, value as number[]);
      rpmCount++;
    }
  }
  log.info("ratelimit", "Rate limits loaded from KV", { models: infoCount, rpmWindows: rpmCount });
}

// ── Header-Based Tracking (RPD / TPM) ──────────────────────────

/** Parse Groq Go-style duration strings like "6m30.123s", "59.23s", "1h2m3s" */
function parseDuration(val: string): number {
  let ms = 0;
  const h = val.match(/(\d+)h/);
  const m = val.match(/([\d.]+)m(?!s)/);
  const s = val.match(/([\d.]+)s/);
  if (h) ms += parseInt(h[1]) * 3600000;
  if (m) ms += parseFloat(m[1]) * 60000;
  if (s) ms += parseFloat(s[1]) * 1000;
  return ms;
}

export function updateFromHeaders(model: string, headers: Headers): void {
  const now = Date.now();
  const limitReq = headers.get("x-ratelimit-limit-requests");
  const remainReq = headers.get("x-ratelimit-remaining-requests");
  const resetReq = headers.get("x-ratelimit-reset-requests");
  const limitTok = headers.get("x-ratelimit-limit-tokens");
  const remainTok = headers.get("x-ratelimit-remaining-tokens");
  const resetTok = headers.get("x-ratelimit-reset-tokens");

  if (!limitReq && !remainReq) return;

  const info: RateLimitInfo = {
    rpdLimit: parseInt(limitReq ?? "0") || 0,
    rpdRemaining: parseInt(remainReq ?? "0") || 0,
    rpdResetAt: resetReq ? now + parseDuration(resetReq) : 0,
    tpmLimit: parseInt(limitTok ?? "0") || 0,
    tpmRemaining: parseInt(remainTok ?? "0") || 0,
    tpmResetAt: resetTok ? now + parseDuration(resetTok) : 0,
    updatedAt: now,
  };
  store.set(model, info);
  saveRateLimitInfo(model, info);
}

// ── Load Calculation ────────────────────────────────────────────

/**
 * Usage percentage for a single header-based dimension.
 * Returns -1 if no data (limit unknown). Returns 0 if the reset window
 * has expired (usage cleared). Otherwise returns 0–100.
 */
function dimensionUsage(
  limit: number,
  remaining: number,
  resetAt: number,
): number {
  if (limit <= 0) return -1;
  const now = Date.now();
  if (resetAt > 0 && now > resetAt) return 0; // window reset — usage cleared
  return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
}

/**
 * Returns per-dimension load info for a model.
 * Order: TPM (resets in seconds), RPM (60s window), RPD (daily).
 * Each dimension is 0–100 or -1 if never measured.
 */
export function getLoadInfo(model: string): LoadInfo {
  const info = store.get(model);
  const rpm = rpmUsagePercent(model);

  if (!info) {
    return { tpm: -1, rpm: rpm >= 0 ? rpm : -1, rpd: -1 };
  }

  const rpd = dimensionUsage(info.rpdLimit, info.rpdRemaining, info.rpdResetAt);
  const tpm = dimensionUsage(info.tpmLimit, info.tpmRemaining, info.tpmResetAt);

  return { tpm, rpm: rpm >= 0 ? rpm : -1, rpd };
}

const SKIP_THRESHOLD = 95;

/**
 * Should we preemptively skip this model?
 * Returns true if any dimension (TPM, RPM, RPD) is near threshold.
 * Returns false if no data (give it a try).
 */
export function shouldSkipModel(model: string): boolean {
  const load = getLoadInfo(model);
  const skip = load.tpm >= SKIP_THRESHOLD ||
    load.rpm >= SKIP_THRESHOLD ||
    load.rpd >= SKIP_THRESHOLD;
  if (skip) {
    log.debug("ratelimit", "Model skip decision", { model, tpm: load.tpm, rpm: load.rpm, rpd: load.rpd });
  }
  return skip;
}
