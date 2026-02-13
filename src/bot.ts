import { Bot, InputFile } from "grammy";
import { log } from "./logger.ts";
import { deliberate } from "./magi/engine.ts";
import { renderMagiImage } from "./image/renderer.ts";
import { detectLanguage } from "./i18n/detector.ts";
import { t, tRandom, tVerdict, type MessageKey } from "./i18n/messages.ts";
import { getLoadInfo } from "./groq/ratelimits.ts";
import { DATA_PROCESSING_MODEL, getPersonaConfigs, LANGUAGE_NAMES } from "./groq/personas.ts";
import {
  formatRemaining,
  getCooldownMs,
  getLastRequest,
  getQueryCount,
  getUserPref,
  incrementQueryCount,
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
      const dims = [load.tpm, load.rpm, load.rpd].filter((v) => v >= 0);
      if (dims.length === 0 || dims.every((v) => v === 0)) {
        return tl("statusStandby");
      }
      return `(T:${fmtDim(load.tpm)} / R:${fmtDim(load.rpm)} / D:${fmtDim(load.rpd)})`;
    }

    function isActive(model: string): { active: boolean; highLoad: boolean } {
      const load = getLoadInfo(model);
      const dims = [load.tpm, load.rpm, load.rpd].filter((v) => v >= 0);
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
    for (const model of [DATA_PROCESSING_MODEL, emergencyModel]) {
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

  // ── Shared deliberation handler ──────────────────────────────────

  // deno-lint-ignore no-explicit-any
  async function handleDeliberation(ctx: any, question: string) {
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
      // Deliberate with all three MAGI cores
      const result = await deliberate(groqApiKey, question, deliberationLang);
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
