import { createCanvas } from "canvas";
import { getPersonaConfigs } from "../groq/personas.ts";
import { log } from "../logger.ts";
import { computeDeliberationResult, type DeliberationResult, type MagiDeliberation, type Verdict } from "../magi/types.ts";

const W = 1200;
const H = 900;
const F = "GoNotoKurrent";

const FONT_PATH = new URL("../../assets/fonts/GoNotoKurrent-Regular.ttf", import.meta.url).pathname;

// Shared font data — read once, freed after canvas init
let _fontData: Uint8Array | null = null;
function getFontData(): Uint8Array {
  if (!_fontData) _fontData = Deno.readFileSync(FONT_PATH);
  return _fontData;
}

/** Release raw font bytes after canvases have loaded the font. */
function releaseFontData(): void {
  _fontData = null;
}

// Singleton render canvas — reused across calls to prevent WASM memory growth
let _renderCanvas: ReturnType<typeof createCanvas> | null = null;
// deno-lint-ignore no-explicit-any
type CanvasCtx = any;
let _renderCtx: CanvasCtx = null;
function getRenderCtx(): { canvas: ReturnType<typeof createCanvas>; ctx: CanvasCtx } {
  if (!_renderCanvas) {
    _renderCanvas = createCanvas(W, H);
    try {
      _renderCanvas.loadFont(getFontData(), { family: F });
    } catch (e) {
      log.error("renderer", "Render canvas font load failed", { error: e instanceof Error ? e.message : String(e) });
    }
    _renderCtx = _renderCanvas.getContext("2d");
  }
  return { canvas: _renderCanvas, ctx: _renderCtx };
}

// Palette inspired by the handheld MAGI terminal scene
// Each hue: dim → mid → base → bright
const C = {
  // Background
  bg: "#0a0408",
  panel: "#0c0610",
  scanline: "rgba(0,8,0,0.3)",

  // Green
  greenDim: "#005a2a",
  greenMid: "#00aa55",
  green: "#00cc66",
  greenBright: "#00ff88",

  // Amber
  amberDim: "#664400",
  amberMid: "#997711",
  amber: "#cc8800",
  amberBright: "#ffaa00",

  // Red
  redMid: "#aa3030",
  red: "#cc2020",
  redBright: "#ff4444",

  // Gray
  gray: "#555555",
  grayBright: "#888888",

  // Text (green-tinted)
  textInfo: "#88aa88",
  textBright: "#aaccaa",
};

function font(weight: string, size: number): string {
  return `${weight} ${size}px ${F}`;
}

function verdictColor(v: Verdict): string {
  if (v === "APPROVE") return C.green;
  if (v === "DENY") return C.red;
  if (v === "REFUSE") return C.gray;
  return C.amber;
}

function verdictBright(v: Verdict): string {
  if (v === "APPROVE") return C.greenBright;
  if (v === "DENY") return C.redBright;
  if (v === "REFUSE") return C.grayBright;
  return C.amberBright;
}

function verdictKanji(v: Verdict): string {
  if (v === "APPROVE") return "\u8CDB\u6210";           // 賛成
  if (v === "DENY") return "\u53CD\u5BFE";               // 反対
  if (v === "REFUSE") return "\u62D2\u5426";             // 拒否
  return "\u6761\u4EF6\u4ED8\u8CDB\u6210";               // 条件付賛成
}

// Pixel-accurate text measurement via render-and-scan.
// canvas@v1.4.2 WASM: measureText returns advance width, not visual bounds.
// Bold fonts use faux-bold (no bold .ttf loaded) but measureText ignores the extra width.
// CJK glyphs are also underestimated. Pixel scanning solves both issues.
//
// Memory optimization: the measure canvas is created during initRenderer(),
// used to pre-warm the cache for all known font+text combos, then destroyed.
// After init, measureVisual() serves only from cache.
let _mCanvas: ReturnType<typeof createCanvas> | null = null;
// deno-lint-ignore no-explicit-any
let _mCtx: any = null;
const MCS = 600;
const MCH = 120;
const MCX0 = 100;

function getMCtx() {
  if (_mCtx) return _mCtx;
  _mCanvas = createCanvas(MCS, MCH);
  try {
    _mCanvas.loadFont(getFontData(), { family: F });
  } catch (e) {
    log.error("renderer", "Measure canvas font load failed", { error: e instanceof Error ? e.message : String(e) });
  }
  _mCtx = _mCanvas.getContext("2d");
  return _mCtx;
}

/** Cache for measureVisual — same font+text always yields same result. */
const _measureCache = new Map<string, { left: number; width: number }>();

/** Pixel-scan a single measurement on the measure canvas. */
function pixelScan(mc: CanvasCtx, fontStr: string, text: string): { left: number; width: number } {
  mc.clearRect(0, 0, MCS, MCH);
  mc.fillStyle = "#000";
  mc.fillRect(0, 0, MCS, MCH);
  mc.fillStyle = "#fff";
  mc.font = fontStr;
  mc.fillText(text, MCX0, 80);
  const d = mc.getImageData(0, 0, MCS, MCH).data;
  let minX = MCS, maxX = 0;
  for (let y = 0; y < MCH; y++) {
    for (let x = 0; x < MCS; x++) {
      if (d[(y * MCS + x) * 4] > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return minX > maxX
    ? { left: 0, width: 0 }
    : { left: minX - MCX0, width: maxX - minX + 1 };
}

/** Pixel-scan measurement. Returns left bearing and visual pixel width. */
function measureVisual(fontStr: string, text: string): { left: number; width: number } {
  const key = `${fontStr}\0${text}`;
  const cached = _measureCache.get(key);
  if (cached) return cached;

  // After initRenderer(), _mCtx is null — use WASM measureText as fallback
  if (!_mCtx) {
    log.debug("renderer", "Measurement cache miss after init", { fontStr, text });
    const { ctx } = getRenderCtx();
    const savedFont = ctx.font;
    ctx.font = fontStr;
    const m = ctx.measureText(text);
    ctx.font = savedFont;
    // Approximate: measureText underestimates CJK/bold by ~10%
    const result = { left: 0, width: Math.ceil(m.width * 1.1) };
    _measureCache.set(key, result);
    return result;
  }

  const result = pixelScan(_mCtx, fontStr, text);
  _measureCache.set(key, result);
  return result;
}

/** Compute fillText x to visually center text at cx. */
function centerX(fontStr: string, text: string, cx: number): number {
  const v = measureVisual(fontStr, text);
  return cx - v.left - v.width / 2;
}

// Each MAGI core has a distinct shape

// BALTHASAR-2: hexagon — rectangle with narrowing trapezoid at bottom
// deno-lint-ignore no-explicit-any
function balthasarPath(ctx: any, cx: number, cy: number, w: number, h: number) {
  const hw = w / 2;
  const splitY = cy + h * 0.1;
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy - h / 2);
  ctx.lineTo(cx + hw, cy - h / 2);
  ctx.lineTo(cx + hw, splitY);
  ctx.lineTo(cx + hw * 0.45, cy + h / 2);
  ctx.lineTo(cx - hw * 0.45, cy + h / 2);
  ctx.lineTo(cx - hw, splitY);
  ctx.closePath();
}

// CASPER-3: rectangle with top-RIGHT corner chamfered
// deno-lint-ignore no-explicit-any
function casperPath(ctx: any, cx: number, cy: number, w: number, h: number) {
  const hw = w / 2;
  const hh = h / 2;
  const cut = h * 0.4;
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy - hh);
  ctx.lineTo(cx + hw * 0.35, cy - hh);
  ctx.lineTo(cx + hw, cy - hh + cut);
  ctx.lineTo(cx + hw, cy + hh);
  ctx.lineTo(cx - hw, cy + hh);
  ctx.closePath();
}

// MELCHIOR-1: rectangle with top-LEFT corner chamfered
// deno-lint-ignore no-explicit-any
function melchiorPath(ctx: any, cx: number, cy: number, w: number, h: number) {
  const hw = w / 2;
  const hh = h / 2;
  const cut = h * 0.4;
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy - hh + cut);
  ctx.lineTo(cx - hw * 0.35, cy - hh);
  ctx.lineTo(cx + hw, cy - hh);
  ctx.lineTo(cx + hw, cy + hh);
  ctx.lineTo(cx - hw, cy + hh);
  ctx.closePath();
}

// deno-lint-ignore no-explicit-any
type ShapeFn = (ctx: any, cx: number, cy: number, w: number, h: number) => void;

// deno-lint-ignore no-explicit-any
function drawMagiCore(ctx: any, x: number, y: number, w: number, h: number, name: string, verdict: Verdict, shapeFn: ShapeFn) {
  const vColor = verdictColor(verdict);
  const vBright = verdictBright(verdict);
  const kanji = verdictKanji(verdict);

  // Outer glow
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = vBright;
  shapeFn(ctx, x, y, w + 16, h + 16);
  ctx.fill();
  ctx.restore();

  // Dark fill
  ctx.save();
  ctx.fillStyle = C.panel;
  shapeFn(ctx, x, y, w, h);
  ctx.fill();
  ctx.restore();

  // Tinted inner fill
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = vColor;
  shapeFn(ctx, x, y, w, h);
  ctx.fill();
  ctx.restore();

  // Border
  ctx.save();
  ctx.strokeStyle = vColor;
  ctx.lineWidth = 4;
  shapeFn(ctx, x, y, w, h);
  ctx.stroke();
  ctx.restore();

  // Name (pixel-centered)
  ctx.save();
  ctx.fillStyle = vBright;
  const nameFont = font("bold", 28);
  ctx.font = nameFont;
  ctx.fillText(name, centerX(nameFont, name, x), y + 8);
  ctx.restore();

  // Verdict badge
  ctx.save();
  const badgeFont = font("bold", 30);
  ctx.font = badgeFont;
  const kanjiV = measureVisual(badgeFont, kanji);
  const badgeW = kanjiV.width + 28;
  const badgeH = 44;
  const badgeX = x - badgeW / 2;
  const badgeY = y + 28;

  ctx.fillStyle = vColor;
  ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
  ctx.fillStyle = "#000000";
  ctx.fillText(kanji, badgeX + 14 - kanjiV.left, badgeY + 34);
  ctx.restore();
}

// deno-lint-ignore no-explicit-any
function drawConnections(ctx: any, positions: Array<[number, number]>) {
  ctx.save();
  ctx.strokeStyle = C.greenMid;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.5;

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      ctx.beginPath();
      ctx.moveTo(positions[i][0], positions[i][1]);
      ctx.lineTo(positions[j][0], positions[j][1]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Evangelion-themed constants (replaces Math.random)
const EVA = {
  code: "E-0913",       // Second Impact: 2000-09-13
  priority: "AAA",      // NERV highest priority
  protocol: 707,        // EVA-00 awakening (ep 5+7)
  sysVer: "2015.03",    // 2015 (NGE in-universe year), 03 (3 cores)
  syncRate: "99.70",    // Pilot sync rate concept
  coreTemp: {
    melchior: "36.1",   // Scientist — precise, cool
    balthasar: "36.8",  // Mother — warm
    casper: "35.4",     // Woman — cold
  },
  location: "GEO-FRONT TOKYO-3",
};

function modelTier(model: string, primary: string, fallbacks: string[], emergency: string): string {
  if (model === primary) return "PRIMARY";
  if (fallbacks.length > 0 && model === fallbacks[0]) return "SUB";
  if (fallbacks.length > 1 && model === fallbacks[1]) return "BACKUP";
  if (model === emergency) return "EMERGENCY";
  return "UNKNOWN";
}

function tierColor(tier: string): string {
  if (tier === "PRIMARY") return C.greenMid;
  if (tier === "SUB") return C.amberMid;
  if (tier === "BACKUP") return C.redMid;
  if (tier === "EMERGENCY") return C.grayBright;
  return C.gray;  // UNKNOWN — all models failed, dead/offline
}

// deno-lint-ignore no-explicit-any
function drawDash(ctx: any, y: number, x0: number, x1: number) {
  ctx.save();
  ctx.strokeStyle = C.greenMid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let dx = x0; dx < x1; dx += 16) {
    ctx.moveTo(dx, y);
    ctx.lineTo(dx + 8, y);
  }
  ctx.stroke();
  ctx.restore();
}

// deno-lint-ignore no-explicit-any
function drawLeftPanel(ctx: any, operatorName: string | undefined, d: MagiDeliberation) {
  const x = 32;

  // ── Upper section (textBright) ──
  ctx.save();
  ctx.fillStyle = C.textBright;
  ctx.font = font("normal", 20);
  let ly = 44;
  ctx.fillText("DIRECT LINK", x, ly); ly += 26;
  ctx.fillText("CONNECTION  MAGI 01", x, ly); ly += 44;

  ctx.font = font("normal", 18);
  ctx.fillText("ACCESS: SUPERVISOR", x, ly); ly += 26;
  if (operatorName) {
    ctx.fillText(`OPERATOR: ${operatorName}`, x, ly); ly += 26;
  }
  ctx.fillText("PERMISSION: CLASS-A", x, ly); ly += 30;
  ctx.font = font("normal", 16);
  ctx.fillText(`NERV MAGI v${EVA.sysVer}`, x, ly); ly += 22;
  ctx.fillText(EVA.location, x, ly);
  ctx.restore();

  // ── Middle section: core status (amberMid) ──
  ly += 54;
  drawDash(ctx, ly, x, 320);
  ly += 39;

  ctx.save();
  ctx.fillStyle = C.amberMid;
  ctx.font = font("bold", 16);
  ctx.fillText("CORE STATUS", x, ly); ly += 30;

  // Derive full model chain from persona configs (language-independent)
  const pc = getPersonaConfigs("en");
  const coreData = [
    { name: pc.melchior.name, temp: EVA.coreTemp.melchior, model: d.melchior.model, config: pc.melchior },
    { name: pc.balthasar.name, temp: EVA.coreTemp.balthasar, model: d.balthasar.model, config: pc.balthasar },
    { name: pc.casper.name, temp: EVA.coreTemp.casper, model: d.casper.model, config: pc.casper },
  ];

  for (const core of coreData) {
    const tier = modelTier(core.model, core.config.model, core.config.fallbackModels, core.config.emergencyModel);
    ctx.font = font("normal", 16);
    ctx.fillStyle = C.amberMid;
    ctx.fillText(`${core.name}  ${core.temp}\u00B0C`, x, ly); ly += 20;
    ctx.font = font("normal", 14);
    ctx.fillStyle = tierColor(tier);
    ctx.fillText(`  TIER: ${tier}`, x, ly); ly += 28;
  }

  ctx.fillStyle = C.amberMid;
  ctx.font = font("normal", 16);
  ctx.fillText(`SYNC RATE: ${EVA.syncRate}%`, x, ly); ly += 22;
  ctx.fillText("A.T.FIELD: ACTIVE", x, ly); ly += 22;

  if (d.searchFailed) {
    ctx.fillStyle = C.red;
    ctx.fillText("DATA LINK: OFFLINE", x, ly);
  } else {
    ctx.fillText("DATA LINK: ACTIVE", x, ly);
  }
  ly += 22;
  if (d.imageContext) {
    ctx.fillStyle = C.amberMid;
    ctx.fillText("IMAGE LINK: ACTIVE", x, ly); ly += 22;
  }
  if (d.fileContext) {
    ctx.fillStyle = C.amberMid;
    ctx.fillText("FILE LINK: ACTIVE", x, ly); ly += 22;
  }
  if (d.userContext) {
    ctx.fillStyle = C.amberMid;
    ctx.fillText("MEMORY LINK: ACTIVE", x, ly);
  }
  ctx.restore();

  // ── Lower section (amberMid) ──
  ly += 54;
  drawDash(ctx, ly, x, 320);
  ly += 39;

  ctx.save();
  ctx.fillStyle = C.amberMid;
  ctx.font = font("normal", 16);
  ctx.fillText(`CODE:${EVA.code}`, x, ly); ly += 22;
  ctx.fillText(`PRIORITY: ${EVA.priority}`, x, ly); ly += 22;
  ctx.fillText(`PROTOCOL: ${EVA.protocol}`, x, ly); ly += 22;
  const now = new Date();
  const utc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")} UTC`;
  ctx.fillText(utc, x, ly);
  ctx.restore();

  // Result label (textBright)
  ly += 54;
  ctx.save();
  ctx.fillStyle = C.textBright;
  ctx.font = font("normal", 20);
  ctx.fillText("RESULT OF THE", x, ly); ly += 26;
  ctx.fillText("DELIBERATION", x, ly);
  ctx.restore();
}

const RESULT_JA: Record<DeliberationResult, { text: string; color: string }> = {
  approved:    { text: "\u53EF\u6C7A",                    color: C.green },  // 可決
  denied:      { text: "\u5426\u6C7A",                    color: C.red },    // 否決
  conditional: { text: "\u6761\u4EF6\u4ED8\u53EF\u6C7A", color: C.amber },  // 条件付可決
  noConsensus: { text: "\u5408\u610F\u4E0D\u6210\u7ACB",  color: C.gray },   // 合意不成立
};

// deno-lint-ignore no-explicit-any
function drawScanlines(ctx: any) {
  ctx.save();
  for (let y = 0; y < H; y += 4) {
    ctx.fillStyle = C.scanline;
    ctx.fillRect(0, y, W, 1);
  }
  ctx.restore();
}

// deno-lint-ignore no-explicit-any
function drawNoise(ctx: any) {
  ctx.save();
  ctx.globalAlpha = 0.015;
  for (let i = 0; i < 2000; i++) {
    ctx.fillStyle = C.greenBright;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  ctx.restore();
}

/**
 * Initialize the renderer eagerly: create canvases, load font, pre-warm
 * the measurement cache for all known font+text combos, then destroy the
 * measurement canvas and release raw font bytes.
 *
 * Saves ~30 MB (15 MB font data + 15 MB WASM font in measure canvas).
 * Must be called once at startup before any renderMagiImage() calls.
 */
export function initRenderer(): void {
  // 1. Initialize both canvases with font
  getRenderCtx();
  const mc = getMCtx();

  // 2. Pre-warm measurement cache for ALL known font+text combos
  const coreNames = ["MELCHIOR\u30FB1", "BALTHASAR\u30FB2", "CASPER\u30FB3"];
  const verdictTexts = ["\u8CDB\u6210", "\u53CD\u5BFE", "\u62D2\u5426", "\u6761\u4EF6\u4ED8\u8CDB\u6210"]; // 賛成 反対 拒否 条件付賛成
  const resultTexts = ["\u53EF\u6C7A", "\u5426\u6C7A", "\u6761\u4EF6\u4ED8\u53EF\u6C7A", "\u5408\u610F\u4E0D\u6210\u7ACB"]; // 可決 否決 条件付可決 合意不成立

  const warmups: Array<[string, string]> = [
    // Core names (bold 28) — used in drawMagiCore
    ...coreNames.map((t): [string, string] => [font("bold", 28), t]),
    // Verdict kanji (bold 30) — used in drawMagiCore badge
    ...verdictTexts.map((t): [string, string] => [font("bold", 30), t]),
    // Verdict kanji (bold 18) — used in bottom bar
    ...verdictTexts.map((t): [string, string] => [font("bold", 18), t]),
    // Result kanji (bold 32) — used in bottom bar result
    ...resultTexts.map((t): [string, string] => [font("bold", 32), t]),
    // "MAGI" (bold 56) — used in center of triangle
    [font("bold", 56), "MAGI"],
  ];

  for (const [fontStr, text] of warmups) {
    const key = `${fontStr}\0${text}`;
    if (!_measureCache.has(key)) {
      _measureCache.set(key, pixelScan(mc, fontStr, text));
    }
  }

  // 3. Destroy measure canvas — all measurements are cached
  _mCanvas = null;
  _mCtx = null;

  // 4. Release raw font bytes — no longer needed
  releaseFontData();

  log.info("renderer", "Renderer initialized", { cachedMeasurements: _measureCache.size });
}

export function renderMagiImage(
  deliberation: MagiDeliberation,
  operatorName?: string,
): Uint8Array {
  const { canvas, ctx } = getRenderCtx();

  // Clear canvas for reuse
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // CRT vignette — centered on right core area
  const cx = 775;
  const grad = ctx.createRadialGradient(cx, H / 2, 120, cx, H / 2, 500);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Left panel text
  drawLeftPanel(ctx, operatorName, deliberation);

  // Vertical divider
  ctx.save();
  ctx.strokeStyle = C.greenMid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.moveTo(350, 20);
  ctx.lineTo(350, H - 75);
  ctx.stroke();
  ctx.restore();

  // Core positions (right area, centered at cx=775, shifted -40px up for balance)
  const baltPos: [number, number] = [cx, 270];
  const caspPos: [number, number] = [cx - 200, 550];
  const melcPos: [number, number] = [cx + 200, 550];

  // Connection lines between cores
  drawConnections(ctx, [baltPos, caspPos, melcPos]);

  // "MAGI" in center of triangle
  ctx.save();
  ctx.fillStyle = C.amberBright;
  const magiFont = font("bold", 56);
  ctx.font = magiFont;
  // Triangle centroid: (775, 457). Baseline = centroid + fontSize*0.35 for visual center.
  ctx.fillText("MAGI", centerX(magiFont, "MAGI", cx), 477);
  ctx.restore();

  // Three cores — each with distinct shape
  drawMagiCore(ctx, baltPos[0], baltPos[1], 340, 240, "BALTHASAR\u30FB2", deliberation.balthasar.verdict, balthasarPath);
  drawMagiCore(ctx, caspPos[0], caspPos[1], 280, 280, "CASPER\u30FB3", deliberation.casper.verdict, casperPath);
  drawMagiCore(ctx, melcPos[0], melcPos[1], 280, 280, "MELCHIOR\u30FB1", deliberation.melchior.verdict, melchiorPath);

  // Bottom result bar
  const resultEntry = RESULT_JA[computeDeliberationResult(deliberation)];
  const result = resultEntry.text;
  const resColor = resultEntry.color;

  ctx.save();
  ctx.fillStyle = C.panel;
  ctx.fillRect(0, H - 75, W, 75);
  ctx.strokeStyle = C.greenMid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H - 75);
  ctx.lineTo(W, H - 75);
  ctx.stroke();

  // Left: individual core verdicts
  const cores = [
    { label: "MELCHIOR\u30FB1", verdict: deliberation.melchior.verdict },
    { label: "BALTHASAR\u30FB2", verdict: deliberation.balthasar.verdict },
    { label: "CASPER\u30FB3", verdict: deliberation.casper.verdict },
  ];

  let ix = 32;
  for (const c of cores) {
    const vc = verdictColor(c.verdict);
    const vk = verdictKanji(c.verdict);
    ctx.fillStyle = C.textInfo;
    ctx.font = font("normal", 18);
    ctx.fillText(c.label, ix, H - 48);

    const vkFont = font("bold", 18);
    ctx.font = vkFont;
    const vkV = measureVisual(vkFont, vk);
    const bw = vkV.width + 16;
    ctx.fillStyle = vc;
    ctx.fillRect(ix, H - 40, bw, 26);
    ctx.fillStyle = "#000000";
    ctx.fillText(vk, ix + 8 - vkV.left, H - 20);
    ix += 194;
  }

  // Right: final result
  ctx.strokeStyle = C.greenMid;
  ctx.beginPath();
  ctx.moveTo(630, H - 67);
  ctx.lineTo(630, H - 8);
  ctx.stroke();

  ctx.fillStyle = C.textInfo;
  ctx.font = font("normal", 20);
  ctx.fillText("RESULT OF THE DELIBERATION", 660, H - 48);
  ctx.fillStyle = resColor;
  ctx.font = font("bold", 32);
  ctx.fillText(result, 660, H - 14);
  ctx.restore();

  // CRT effects
  drawScanlines(ctx);
  drawNoise(ctx);

  return canvas.toBuffer();
}
