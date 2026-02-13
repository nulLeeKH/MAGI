import { Bot, InputFile } from "grammy";
import { log } from "./logger.ts";
import { compressContext, deliberate } from "./magi/engine.ts";
import { renderMagiImage } from "./image/renderer.ts";
import { detectLanguage } from "./i18n/detector.ts";
import { t, tRandom, tVerdict, type MessageKey } from "./i18n/messages.ts";
import { getLoadInfo, shouldSkipModel } from "./groq/ratelimits.ts";
import { DATA_PROCESSING_MODEL, getPersonaConfigs, LANGUAGE_NAMES, MODELS } from "./groq/personas.ts";
import {
  formatRemaining,
  getCooldownMs,
  getUserContext,
  getLastRequest,
  getQueryCount,
  getUserPref,
  incrementQueryCount,
  setUserContext,
  setLastRequest,
  setUserPref,
} from "./storage.ts";
import {
  computeDeliberationResult,
  type DeliberationResult,
  type SupportedLanguage,
} from "./magi/types.ts";

const NERV_QUOTES = [
  // Ikari Shinji
  "逃げちゃダメだ、逃げちゃダメだ、逃げちゃダメだ...\n— Ikari Shinji",
  "笑えばいいと思うよ。\n— Ikari Shinji",
  "僕はここにいてもいいんだ！\n— Ikari Shinji",
  "知らない天井だ。\n— Ikari Shinji",
  "目標をセンターに入れてスイッチ。\n— Ikari Shinji",
  "僕はエヴァンゲリオン初号機パイロット、碇シンジです！\n— Ikari Shinji",
  "僕がどうなったっていい...世界がどうなったっていい...だけど綾波は、せめて綾波だけは...絶対、助ける！\n— Ikari Shinji",
  "裏切ったな、僕の気持ちを裏切ったな。父さんと同じに裏切ったんだ！\n— Ikari Shinji",
  "自分には何もないって、悲しいこと言うなよ...別れ際にさよならなんて、寂しいこと言うなよ...\n— Ikari Shinji",
  // Ayanami Rei
  "ごめんなさい。こういうときどんな顔をすればいいかわからないの。\n— Ayanami Rei",
  "私は、あなたの人形じゃない。\n— Ayanami Rei",
  "碇くんは、碇くんだけのために、エヴァに乗ってください。\n— Ayanami Rei",
  "ここにいてもいいの？\n— Ayanami Rei",
  "じゃあ寝てたら、初号機にはあたしが乗る。\n— Ayanami Rei",
  "他人の存在を今一度望めば、再び心の壁が全ての人々の心を引き離すわ。\n— Ayanami Rei",
  // Souryuu Asuka Langley
  "あんたバカぁ？\n— Souryuu Asuka Langley",
  "気持ち悪い。\n— Souryuu Asuka Langley",
  "わかってるわ。私はエヴァに乗るしかないのよ。\n— Souryuu Asuka Langley",
  "なんだか楽になったわ。誰かと話すって心地いいのね。知らなかった。\n— Souryuu Asuka Langley",
  "生き物は生き物食べて、生きてんのよ。せっかくの命は、全部漏れなく食べ尽くしなさいよ！\n— Souryuu Asuka Langley",
  // Nagisa Kaworu
  "希望は残っているよ。どんな時にもね。\n— Nagisa Kaworu",
  "好きってことさ。\n— Nagisa Kaworu",
  "君に会うために生まれてきたのかもしれない。\n— Nagisa Kaworu",
  // Katsuragi Misato
  "奇跡を待つより捨て身の努力よ！\n— Katsuragi Misato",
  "あんたまだ生きてるんでしょう！？だったらしっかり生きて！それから死になさい！\n— Katsuragi Misato",
  "風呂は命の洗濯よ。\n— Katsuragi Misato",
  "この世界はあなたの知らない面白い事で、満ち満ちているわよ。楽しみなさい。\n— Katsuragi Misato",
  "あら、希望的観測は人が生きていくための必需品よ。\n— Katsuragi Misato",
  // Ikari Gendo
  "人類補完計画... 全ては、シナリオ通りに。\n— Ikari Gendo",
  "時計の針は元には戻らない。だが、自らの手で進めることは出来る。\n— Ikari Gendo",
  "所詮、人間の敵は人間だよ。\n— Ikari Gendo",
  // NERV / SEELE
  "God's in his heaven. All's right with the world.\n— NERV Motto",
  "The fate of destruction is also the joy of rebirth.\n— SEELE",
];

/** Escape HTML special characters to prevent Telegram parse errors. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB Groq base64 limit

/**
 * Download the largest suitable photo from Telegram and return as base64.
 * Picks the largest PhotoSize under 4MB. Returns null on failure.
 */
// deno-lint-ignore no-explicit-any
async function downloadPhotoAsBase64(ctx: any, botToken: string): Promise<string | null> {
  try {
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return null;

    // Pick largest photo under 4MB (Telegram sorts ascending by size)
    let chosen = null;
    for (let i = photos.length - 1; i >= 0; i--) {
      const size = photos[i].file_size;
      if (size === undefined || size <= MAX_IMAGE_BYTES) {
        chosen = photos[i];
        break;
      }
    }
    if (!chosen) chosen = photos[0]; // fallback to smallest

    const file = await ctx.api.getFile(chosen.file_id);
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      log.error("bot", "Photo download failed", { status: response.status });
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      log.warn("bot", "Downloaded photo exceeds 4MB limit", { bytes: buffer.byteLength });
      return null;
    }

    // Convert to base64 (chunked to avoid stack overflow on large files)
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch (err) {
    log.error("bot", "Photo download error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Document (file) support ──────────────────────────────────────

const MAX_TEXT_BYTES = 256 * 1024; // 256KB
const MAX_TEXT_CHARS = 8000;

const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html", "text/css",
  "text/xml", "application/json", "application/yaml", "application/xml",
  "application/javascript", "application/typescript",
]);

const TEXT_EXTS = new Set([
  "txt", "md", "csv", "log", "ts", "tsx", "js", "jsx", "py",
  "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "cs", "php",
  "sh", "bash", "json", "yaml", "yml", "toml", "xml", "html", "css",
  "scss", "sql", "graphql", "env", "conf", "ini", "svg",
]);

function isImageMime(mime?: string): boolean {
  return !!mime?.startsWith("image/");
}

function isTextFile(mime?: string, fileName?: string): boolean {
  if (mime && TEXT_MIMES.has(mime)) return true;
  if (mime?.startsWith("text/")) return true;
  if (fileName) {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext && TEXT_EXTS.has(ext)) return true;
  }
  return false;
}

/** Download a document file from Telegram and return as base64. */
// deno-lint-ignore no-explicit-any
async function downloadDocAsBase64(ctx: any, botToken: string): Promise<string | null> {
  try {
    const doc = ctx.message.document;
    if (!doc) return null;

    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      log.error("bot", "Document download failed", { status: response.status });
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      log.warn("bot", "Downloaded document exceeds 4MB limit", { bytes: buffer.byteLength });
      return null;
    }

    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch (err) {
    log.error("bot", "Document download error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Download a document file from Telegram and return as text string. */
// deno-lint-ignore no-explicit-any
async function downloadDocAsText(ctx: any, botToken: string): Promise<string | null> {
  try {
    const doc = ctx.message.document;
    if (!doc) return null;

    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      log.error("bot", "Text document download failed", { status: response.status });
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      log.warn("bot", "Text document exceeds 256KB limit", { bytes: buffer.byteLength });
      return null;
    }

    return new TextDecoder().decode(buffer);
  } catch (err) {
    log.error("bot", "Text document download error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

let startTime = Date.now();


/**
 * Per-user language resolution. Priority:
 * 1. fixedLang (set via /lang)
 * 2. detected language from text (saved as detectedLang on /magi)
 * 3. previous detectedLang from KV
 * 4. "en" default
 */
async function resolveLang(
  userId: number | undefined,
  text?: string,
): Promise<SupportedLanguage> {
  if (!userId) return "en";

  const pref = await getUserPref(userId);

  if (text) {
    const detected = detectLanguage(text);
    await setUserPref(userId, { ...pref, detectedLang: detected });
    return pref?.fixedLang ?? detected;
  }

  return pref?.fixedLang ?? pref?.detectedLang ?? "en";
}

const RESULT_I18N: Record<DeliberationResult, MessageKey> = {
  approved: "resultApproved",
  denied: "resultDenied",
  conditional: "resultConditional",
  noConsensus: "resultNoConsensus",
};

function formatUptime(): string {
  const ms = Date.now() - startTime;
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function createBot(telegramToken: string, groqApiKey: string): Bot {
  const bot = new Bot(telegramToken);
  startTime = Date.now();

  // Photo handler — registered BEFORE command handlers to work around grammY bug
  // where bot.command() crashes on photo messages (msg.entities is undefined for
  // photos, but the ":entities:bot_command" filter matches caption_entities).
  bot.on("message:photo", async (ctx) => {
    const rawCaption = ctx.message.caption?.trim() ?? "";
    const captionEntities = ctx.message.caption_entities ?? [];

    // Detect /magi command in caption
    const firstEntity = captionEntities[0];
    const hasMagiCommand = firstEntity?.offset === 0
      && firstEntity.type === "bot_command"
      && rawCaption.slice(0, firstEntity.length).split("@")[0].toLowerCase() === "/magi";

    // Strip /magi prefix if present, otherwise use full caption
    let question = hasMagiCommand
      ? rawCaption.slice(firstEntity!.length).trim()
      : rawCaption;

    if (ctx.chat.type === "private") {
      if (!rawCaption) {
        const lang = await resolveLang(ctx.from?.id);
        await ctx.reply(t(lang, "noCaption"));
        return;
      }

      if (hasMagiCommand && !question) {
        const lang = await resolveLang(ctx.from?.id);
        await ctx.reply(t(lang, "noQuestion"));
        return;
      }

      const imageBase64 = await downloadPhotoAsBase64(ctx, telegramToken);
      if (!imageBase64) {
        log.warn("bot", "Photo download failed, falling back to text-only");
        await handleDeliberation(ctx, question);
        return;
      }

      await handleDeliberation(ctx, question, imageBase64);
      return;
    }

    // Group: caption must start with @mention or /magi command
    if (captionEntities.length === 0) return;

    if (hasMagiCommand) {
      if (!question) return;
    } else {
      const first = captionEntities[0];
      if (first.offset !== 0) return;

      let isBotMention = false;
      if (first.type === "mention") {
        const mentioned = rawCaption.slice(1, first.length).toLowerCase();
        isBotMention = mentioned === ctx.me.username.toLowerCase();
      } else if (first.type === "text_mention" && first.user) {
        isBotMention = first.user.id === ctx.me.id;
      }

      if (!isBotMention) return;

      question = rawCaption.slice(first.length).trim();
      if (!question) return;
    }

    const imageBase64 = await downloadPhotoAsBase64(ctx, telegramToken);
    if (!imageBase64) {
      log.warn("bot", "Photo download failed in group, falling back to text-only");
      await handleDeliberation(ctx, question);
      return;
    }

    await handleDeliberation(ctx, question, imageBase64);
  });

  // Document handler — handles images sent as files (small images) + text-based files
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;

    const rawCaption = ctx.message.caption?.trim() ?? "";
    const captionEntities = ctx.message.caption_entities ?? [];

    // Detect /magi command in caption
    const firstEntity = captionEntities[0];
    const hasMagiCommand = firstEntity?.offset === 0
      && firstEntity.type === "bot_command"
      && rawCaption.slice(0, firstEntity.length).split("@")[0].toLowerCase() === "/magi";

    let question = hasMagiCommand
      ? rawCaption.slice(firstEntity!.length).trim()
      : rawCaption;

    // Group: require /magi command or @mention
    if (ctx.chat.type !== "private") {
      if (captionEntities.length === 0) return;

      if (hasMagiCommand) {
        if (!question) return;
      } else {
        const first = captionEntities[0];
        if (first.offset !== 0) return;

        let isBotMention = false;
        if (first.type === "mention") {
          const mentioned = rawCaption.slice(1, first.length).toLowerCase();
          isBotMention = mentioned === ctx.me.username.toLowerCase();
        } else if (first.type === "text_mention" && first.user) {
          isBotMention = first.user.id === ctx.me.id;
        }

        if (!isBotMention) return;

        question = rawCaption.slice(first.length).trim();
        if (!question) return;
      }
    } else {
      // DM: require caption
      if (!rawCaption) {
        const lang = await resolveLang(ctx.from?.id);
        await ctx.reply(t(lang, "noCaption"));
        return;
      }
      if (hasMagiCommand && !question) {
        const lang = await resolveLang(ctx.from?.id);
        await ctx.reply(t(lang, "noQuestion"));
        return;
      }
    }

    const lang = await resolveLang(ctx.from?.id, question);

    if (isImageMime(doc.mime_type)) {
      // Image sent as document
      if (doc.file_size && doc.file_size > MAX_IMAGE_BYTES) {
        await ctx.reply(t(lang, "fileTooLarge"));
        return;
      }
      const imageBase64 = await downloadDocAsBase64(ctx, telegramToken);
      if (!imageBase64) {
        log.warn("bot", "Document image download failed, falling back to text-only");
        await handleDeliberation(ctx, question);
        return;
      }
      await handleDeliberation(ctx, question, imageBase64);

    } else if (isTextFile(doc.mime_type, doc.file_name)) {
      // Text-based file
      if (doc.file_size && doc.file_size > MAX_TEXT_BYTES) {
        await ctx.reply(t(lang, "fileTooLarge"));
        return;
      }
      const content = await downloadDocAsText(ctx, telegramToken);
      if (content === null) {
        await ctx.reply(t(lang, "fileTooLarge"));
        return;
      }
      if (content.length > MAX_TEXT_CHARS) {
        await ctx.reply(t(lang, "fileTooLarge"));
        return;
      }
      const fileName = doc.file_name ?? "file";
      const fileContext = `[FILE: ${fileName}]\n${content}`;
      await handleDeliberation(ctx, question, undefined, fileContext);

    } else {
      // Unsupported file type
      await ctx.reply(t(lang, "unsupportedFile"));
    }
  });

  // /start command
  bot.command("start", async (ctx) => {
    const lang = await resolveLang(ctx.from?.id);
    await ctx.reply(t(lang, "welcome"));
  });

  // /help command
  bot.command("help", async (ctx) => {
    const lang = await resolveLang(ctx.from?.id);
    await ctx.reply(t(lang, "help"));
  });

  // /info command
  bot.command("info", async (ctx) => {
    const lang = await resolveLang(ctx.from?.id);
    await ctx.reply(t(lang, "info"));
  });

  // /lang command — set preferred language
  bot.command("lang", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const arg = ctx.match?.trim().toLowerCase();
    const pref = await getUserPref(userId);
    const currentLang = pref?.fixedLang ?? pref?.detectedLang ?? "en";

    const tl = (key: MessageKey, vars?: Record<string, string | number>) =>
      t(currentLang, key, vars);

    // No argument — show current settings and usage
    if (!arg) {
      const mode = pref?.fixedLang ? "fixed" : "auto";
      await ctx.reply(tl("langUsage", { lang: currentLang, mode }));
      return;
    }

    // /lang auto — clear fixed preference
    if (arg === "auto") {
      await setUserPref(userId, { ...pref, fixedLang: undefined });
      const responseLang = pref?.detectedLang ?? "en";
      await ctx.reply(t(responseLang, "langAutoSet"));
      return;
    }

    // /lang en|ja|ko — set fixed preference
    const validLangs: SupportedLanguage[] = ["en", "ja", "ko"];
    if (validLangs.includes(arg as SupportedLanguage)) {
      const newLang = arg as SupportedLanguage;
      await setUserPref(userId, { ...pref, fixedLang: newLang });
      await ctx.reply(t(newLang, "langSet", {
        lang: newLang,
        langName: LANGUAGE_NAMES[newLang],
      }));
      return;
    }

    // Invalid argument
    await ctx.reply(tl("langInvalid"));
  });

  // /status command
  bot.command("status", async (ctx) => {
    const lang = await resolveLang(ctx.from?.id);
    const configs = getPersonaConfigs(lang);

    const tierKeys: MessageKey[] = ["tierMain", "fallbackSub"];

    const tl = (key: MessageKey, vars?: Record<string, string | number>) =>
      t(lang, key, vars);

    const fmtDim = (v: number) => v < 0 ? "--" : `${v.toFixed(1)}%`;

    function formatLoad(model: string): string {
      const load = getLoadInfo(model);
      const dims = [load.tpm, load.rpm, load.rpd, load.tpd].filter((v) => v >= 0);
      if (dims.length === 0 || dims.every((v) => v === 0)) {
        return tl("statusStandby");
      }
      return `(TM:${fmtDim(load.tpm)} / RM:${fmtDim(load.rpm)} / RD:${fmtDim(load.rpd)} / TD:${fmtDim(load.tpd)})`;
    }

    function isActive(model: string): { active: boolean; highLoad: boolean } {
      const load = getLoadInfo(model);
      const dims = [load.tpm, load.rpm, load.rpd, load.tpd].filter((v) => v >= 0);
      if (dims.length === 0 || dims.every((v) => v === 0)) return { active: false, highLoad: false };
      return { active: true, highLoad: dims.some((v) => v >= 90) };
    }

    const coreEntries = [
      { name: configs.melchior.name, config: configs.melchior },
      { name: configs.balthasar.name, config: configs.balthasar },
      { name: configs.casper.name, config: configs.casper },
    ];

    // Count high-load models for summary
    let highLoadCount = 0;
    let totalModels = 0;

    const coreLines: string[] = [];
    for (const { name, config } of coreEntries) {
      const models = [config.model, ...config.fallbackModels];
      for (const model of models) {
        const { active, highLoad } = isActive(model);
        if (active) { totalModels++; if (highLoad) highLoadCount++; }
      }
      const tiers = models.map((model, i) =>
        `    ${tl(tierKeys[i])}: ${formatLoad(model)}`
      ).join("\n");
      coreLines.push(`  ${name}\n${tiers}`);
    }

    // Infrastructure models
    const emergencyModel = configs.melchior.emergencyModel;
    const searchModel = MODELS.COMPOUND;
    for (const model of [DATA_PROCESSING_MODEL, searchModel, emergencyModel]) {
      const { active, highLoad } = isActive(model);
      if (active) { totalModels++; if (highLoad) highLoadCount++; }
    }

    const summaryKey = highLoadCount === 0
      ? "statusAllNominal"
      : highLoadCount >= totalModels && totalModels > 0
        ? "statusAllOverload"
        : "statusPartialOverload";

    const queries = await getQueryCount();

    const lines = [
      tl("statusHeader"),
      "",
      tl("statusUptime", { uptime: formatUptime() }),
      tl("statusQueries", { queries }),
      "",
      tl("statusSectionCore"),
      ...coreLines.flatMap((c, i) => (i > 0 ? ["", c] : [c])),
      "",
      tl("statusSectionInfra"),
      `  ${tl("statusDataProcessing")}: ${formatLoad(DATA_PROCESSING_MODEL)}`,
      `  ${tl("statusDataLink")}: ${formatLoad(searchModel)}`,
      `  ${tl("statusEmergency")}: ${formatLoad(emergencyModel)}`,
      "",
      tl(summaryKey),
    ];

    await ctx.reply(lines.join("\n"));
  });

  // /nerv command
  bot.command("nerv", async (ctx) => {
    const lang = await resolveLang(ctx.from?.id);
    const quote = NERV_QUOTES[Math.floor(Math.random() * NERV_QUOTES.length)];
    await ctx.reply(`${t(lang, "nervHeader")}\n\n${quote}`);
  });

  // /debug command — diagnostic tool (English only)
  bot.command("debug", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply("Error: Cannot identify user.");
      return;
    }

    const sub = (ctx.match ?? "").trim().toLowerCase();

    if (sub === "context") {
      const userCtx = await getUserContext(userId);
      if (!userCtx) {
        await ctx.reply("DEBUG — CONTEXT\n\nNo stored context for this user.");
        return;
      }
      const ageMins = Math.floor((Date.now() - userCtx.updatedAt) / 60000);
      const lines = [
        "DEBUG — CONTEXT",
        "",
        `Updated: ${new Date(userCtx.updatedAt).toISOString()} (${ageMins}m ago)`,
        `Length: ${userCtx.summary.length} chars`,
        "",
        userCtx.summary,
      ];
      await ctx.reply(lines.join("\n"));
      return;
    }

    if (sub === "user") {
      const pref = await getUserPref(userId);
      const lastReq = await getLastRequest(userId);
      const userCtx = await getUserContext(userId);
      const cooldown = getCooldownMs();
      const lines = [
        "DEBUG — USER",
        "",
        `User ID: ${userId}`,
        `Fixed lang: ${pref?.fixedLang ?? "(none)"}`,
        `Detected lang: ${pref?.detectedLang ?? "(none)"}`,
        `Last request: ${lastReq ? new Date(lastReq).toISOString() : "(none)"}`,
        `Cooldown: ${cooldown / 1000}s`,
        `Context: ${userCtx ? `${userCtx.summary.length} chars, updated ${new Date(userCtx.updatedAt).toISOString()}` : "(none)"}`,
      ];
      await ctx.reply(lines.join("\n"));
      return;
    }

    if (sub === "models") {
      const lang = await resolveLang(userId);
      const configs = getPersonaConfigs(lang);

      const fmtDim = (v: number) => v < 0 ? "--" : `${v.toFixed(1)}%`;

      const fmtLoad = (model: string): string => {
        const load = getLoadInfo(model);
        const skip = shouldSkipModel(model);
        return `${model}\n    TM:${fmtDim(load.tpm)} RM:${fmtDim(load.rpm)} RD:${fmtDim(load.rpd)} TD:${fmtDim(load.tpd)}${skip ? " [SKIP]" : ""}`;
      };

      const coreEntries = [
        { label: "MELCHIOR", config: configs.melchior },
        { label: "BALTHASAR", config: configs.balthasar },
        { label: "CASPER", config: configs.casper },
      ];

      const lines = ["DEBUG — MODELS", ""];
      for (const { label, config } of coreEntries) {
        lines.push(`${label}: ${fmtLoad(config.model)}`);
        for (const fb of config.fallbackModels) {
          lines.push(`  fallback: ${fmtLoad(fb)}`);
        }
      }
      lines.push("");
      lines.push(`DATA: ${fmtLoad(DATA_PROCESSING_MODEL)}`);
      lines.push(`EMERGENCY: ${fmtLoad(configs.melchior.emergencyModel)}`);

      await ctx.reply(lines.join("\n"));
      return;
    }

    // Default: show subcommand list
    const lines = [
      "DEBUG — SUBCOMMANDS",
      "",
      "/debug context — Stored conversation context",
      "/debug user — User preferences & state",
      "/debug models — Model assignments & load",
    ];
    await ctx.reply(lines.join("\n"));
  });

  // ── Shared deliberation handler ──────────────────────────────────

  // deno-lint-ignore no-explicit-any
  async function handleDeliberation(ctx: any, question: string, imageBase64?: string, fileContext?: string) {
    const userId = ctx.from?.id as number | undefined;

    // UI language: fast local detection for thinking/rate-limit messages
    const pref = userId ? await getUserPref(userId) : null;
    const uiLang: SupportedLanguage = pref?.fixedLang ?? detectLanguage(question);
    // Deliberation language: fixed or let LLM detect from question
    const deliberationLang: SupportedLanguage | "auto" = pref?.fixedLang ?? "auto";

    log.info("bot", "Deliberation request", {
      userId,
      chatType: ctx.chat?.type,
      question: question.slice(0, 80),
    });

    // Rate limit check
    if (userId) {
      const cooldownMs = getCooldownMs();
      const last = await getLastRequest(userId);
      if (last !== undefined) {
        const elapsed = Date.now() - last;
        if (elapsed < cooldownMs) {
          const remainingMs = cooldownMs - elapsed;
          log.info("bot", "Rate limit hit", { userId, remainingMs });
          await ctx.reply(
            tRandom(uiLang, "rateLimits", {
              remaining: formatRemaining(remainingMs),
            }),
          );
          return;
        }
      }
    }

    // Send thinking indicator (uses fast local lang; deleted after deliberation)
    const thinkingMsg = await ctx.reply(t(uiLang, "thinking"));

    try {
      // Load user context for continuity
      const prevContext = userId ? await getUserContext(userId) : null;
      if (prevContext) {
        log.info("bot", "Context loaded", { userId, length: prevContext.summary.length, summary: prevContext.summary });
      } else {
        log.info("bot", "No context found", { userId });
      }

      // Deliberate with all three MAGI cores
      const result = await deliberate(groqApiKey, question, deliberationLang, imageBase64, prevContext?.summary, fileContext);
      const lang = result.language; // LLM-resolved language

      // Save LLM-detected language for future non-deliberation commands
      if (userId && !pref?.fixedLang) {
        await setUserPref(userId, { ...pref, detectedLang: lang });
      }

      // Check if all three failed
      const allFailed =
        result.melchior.error && result.balthasar.error && result.casper.error;
      if (allFailed) {
        await ctx.reply(t(lang, "error"));
        return;
      }

      // Record rate limit and increment query counter (only on success)
      if (userId) {
        await setLastRequest(userId);
      }
      await incrementQueryCount();

      // Build HTML text response
      const resultKey = RESULT_I18N[computeDeliberationResult(result)];

      const buildBody = (includeHeader: boolean): string => {
        const parts: string[] = [];
        if (includeHeader) {
          parts.push("<b>MAGI SYSTEM — DELIBERATION COMPLETE</b>");
        }
        if (result.approvalCondition) {
          parts.push(`<b>${escapeHtml(t(lang, "conditionLabel"))}:</b> ${escapeHtml(result.approvalCondition)}`);
        }
        parts.push(
          `\n<b>${escapeHtml(t(lang, "melchiorLabel"))} — ${escapeHtml(tVerdict(lang, result.melchior.verdict))}</b>`,
          escapeHtml(result.melchior.content),
          `\n<b>${escapeHtml(t(lang, "balthasarLabel"))} — ${escapeHtml(tVerdict(lang, result.balthasar.verdict))}</b>`,
          escapeHtml(result.balthasar.content),
          `\n<b>${escapeHtml(t(lang, "casperLabel"))} — ${escapeHtml(tVerdict(lang, result.casper.verdict))}</b>`,
          escapeHtml(result.casper.content),
          `\n<b>${escapeHtml(t(lang, "resultLabel"))}: ${escapeHtml(t(lang, resultKey))}</b>`,
        );
        return parts.join("\n").trim();
      };

      // Send image + text as single message (caption) when possible
      const CAPTION_LIMIT = 1024;
      let sent = false;
      try {
        const operatorName = ctx.from?.first_name ?? undefined;
        const imageBuffer = renderMagiImage(result, operatorName);
        const caption = buildBody(false);
        if (caption.length <= CAPTION_LIMIT) {
          await ctx.replyWithPhoto(
            new InputFile(imageBuffer, "magi_deliberation.png"),
            { caption, parse_mode: "HTML" },
          );
        } else {
          await ctx.replyWithPhoto(
            new InputFile(imageBuffer, "magi_deliberation.png"),
          );
          await ctx.reply(caption, { parse_mode: "HTML" });
        }
        sent = true;
      } catch (imgErr) {
        log.error("bot", "Image generation failed", {
          error: imgErr instanceof Error ? imgErr.message : String(imgErr),
        });
      }
      if (!sent) {
        await ctx.reply(buildBody(true), { parse_mode: "HTML" });
      }

      // Compress and save user context (after reply sent)
      if (userId) {
        try {
          const summary = await compressContext(groqApiKey, prevContext?.summary ?? null, question, result);
          if (summary) {
            await setUserContext(userId, { summary, updatedAt: Date.now() });
            log.info("bot", "Context saved", { userId, length: summary.length, summary });
          }
        } catch (err) {
          log.warn("bot", "Context save failed", { userId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Delete thinking indicator
      await ctx.api
        .deleteMessage(ctx.chat.id, thinkingMsg.message_id)
        .catch((err: unknown) => log.debug("bot", "Failed to delete thinking message", { error: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      log.error("bot", "Deliberation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.api
        .deleteMessage(ctx.chat.id, thinkingMsg.message_id)
        .catch((err2: unknown) => log.debug("bot", "Failed to delete thinking message", { error: err2 instanceof Error ? err2.message : String(err2) }));
      await ctx.reply(t(uiLang, "error"));
    }
  }

  // /magi command — main deliberation
  bot.command("magi", async (ctx) => {
    const question = ctx.match?.trim();
    if (!question) {
      const lang = await resolveLang(ctx.from?.id);
      await ctx.reply(t(lang, "noQuestion"));
      return;
    }
    await handleDeliberation(ctx, question);
  });

  // DM: any text → deliberation
  // Group: @mention at offset 0 → deliberation
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type === "private") {
      const question = ctx.message.text.trim();
      if (!question) return;
      await handleDeliberation(ctx, question);
      return;
    }

    const entities = ctx.message.entities ?? [];
    if (entities.length === 0) return;

    const first = entities[0];
    if (first.offset !== 0) return;

    let isBotMention = false;
    if (first.type === "mention") {
      const mentioned = ctx.message.text.slice(1, first.length).toLowerCase();
      isBotMention = mentioned === ctx.me.username.toLowerCase();
    } else if (first.type === "text_mention" && first.user) {
      isBotMention = first.user.id === ctx.me.id;
    }

    if (!isBotMention) return;

    const question = ctx.message.text.slice(first.length).trim();
    if (!question) return;

    await handleDeliberation(ctx, question);
  });

  return bot;
}
