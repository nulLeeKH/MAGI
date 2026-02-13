import { log } from "../logger.ts";
import { recordModelRequest, recordModelTokens, updateFromHeaders } from "./ratelimits.ts";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const FETCH_TIMEOUT_MS = 30_000;

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface GroqRequestOptions {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens?: number;
}

export interface GroqResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class GroqRateLimitError extends Error {
  constructor(public status: number, body: string) {
    super(`Groq rate limit (${status}): ${body}`);
    this.name = "GroqRateLimitError";
  }
}

/** Strip <think>...</think> reasoning blocks (e.g. QWEN3) from model output. */
function stripThinkBlocks(content: string): string {
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return stripped.length > 0 ? stripped : content.trim();
}

export class GroqClient {
  constructor(private apiKey: string) {}

  async chat(options: GroqRequestOptions): Promise<string> {
    // Record request for local RPM tracking before the call
    recordModelRequest(options.model);
    const start = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature,
          ...(options.maxTokens != null && { max_tokens: options.maxTokens }),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Capture rate limit headers from every response (including errors)
    updateFromHeaders(options.model, response.headers);

    if (!response.ok) {
      const body = await response.text();
      log.error("groq", "API error", {
        model: options.model,
        status: response.status,
        latencyMs: Date.now() - start,
        body: body.slice(0, 200),
      });
      if (response.status === 429 || response.status === 503) {
        throw new GroqRateLimitError(response.status, body);
      }
      throw new Error(`Groq API error ${response.status}: ${body}`);
    }

    const data: GroqResponse = await response.json();
    const rawContent = data.choices[0]?.message?.content ?? "";
    const content = stripThinkBlocks(rawContent);

    // Log <think> reasoning blocks before they are stripped
    const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      log.debug("groq", "Think block", {
        model: options.model,
        reasoning: thinkMatch[1].trim().slice(0, 500),
      });
    }

    recordModelTokens(options.model, data.usage.total_tokens);

    log.debug("groq", "API response", {
      model: options.model,
      latencyMs: Date.now() - start,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      contentLength: content.length,
    });
    return content;
  }
}
