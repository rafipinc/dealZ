// Gemini client for the llm_extract source. The only file in DealZ that knows
// the shape of Google's generateContent API, so swapping the provider means
// swapping this file. One structured-output request in, parsed JSON and token
// usage out; every failure is a SourceError under the "gemini" slug so the
// quotes service can tell a model outage from a retailer problem.

import { z } from "zod";
import { beginCall } from "./meter";
import { SourceError, type FetchLike, type Meter } from "./types";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
/** SourceError.retailerSlug for failures of the model service itself. */
export const GEMINI_SLUG = "gemini";
/**
 * The model that reads pages by default. In the 2026-09-28 experiment it
 * matched gemini-3.8-flash on every page at a fifth of the cost.
 */
export const DEFAULT_EXTRACT_MODEL = "gemini-3.5-flash-lite";
/** The larger model, for a caller that wants a second opinion on a doubtful page. */
export const ESCALATION_MODEL = "gemini-3.8-flash";
/** Model calls are slower than page fetches; thinking models slower still. */
export const GEMINI_TIMEOUT_MS = 60_000;

export interface GeminiJsonRequest {
  model: string;
  systemInstruction: string;
  /** The user turn: the page text to read. */
  text: string;
  /** An OpenAPI-style schema the model's JSON must follow. */
  responseSchema: unknown;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Clock for the meter's timing. Defaults to () => new Date(). */
  now?: () => Date;
  /** Told about the one request this makes, with its token counts. */
  meter?: Meter;
  /** The retailer whose page is being read, for the meter. */
  retailerSlug?: string | null;
}

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Zero for models that do not think. */
  thinkingTokens: number;
}

export interface GeminiJsonResult {
  /** The model's answer, parsed. Callers validate it against their own schema. */
  json: unknown;
  usage: GeminiUsage;
  /** The version the service reports, or the requested model when it reports none. */
  model: string;
  /** The response body as received, nothing else. Never the request or the key. */
  raw: unknown;
}

const count = z.number().catch(0);

const responseSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z
          .looseObject({
            parts: z.array(z.looseObject({ text: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .looseObject({
      promptTokenCount: count.optional(),
      candidatesTokenCount: count.optional(),
      thoughtsTokenCount: count.optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
});

export function generateContentUrl(model: string): string {
  return `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
}

/** An error message with the key removed, in case a runtime echoes headers. */
function redact(message: string, apiKey: string): string {
  return apiKey.length === 0 ? message : message.split(apiKey).join("REDACTED");
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Asks the model for JSON that follows `responseSchema`, at temperature 0.
 * Throws SourceError: "network" when the request fails or times out,
 * "blocked" on 401, 403 or 429, "http" on any other non-2xx status and
 * "unparseable" when the body carries no JSON answer.
 */
export async function generateJson(request: GeminiJsonRequest): Promise<GeminiJsonResult> {
  // The meter is told the model that was asked for, not the version the
  // service reports, so the price table has one stable name to look up.
  const finish = beginCall(request.meter, request.now, {
    provider: "gemini",
    operation: "generate_content",
    retailerSlug: request.retailerSlug ?? null,
    model: request.model,
  });
  // Filled in as the response is read, so a call that fails late still
  // reports the status and the tokens it was billed for.
  const seen: Seen = { httpStatus: null, inputTokens: null, outputTokens: null };
  try {
    const result = await requestJson(request, seen);
    finish(seen);
    return result;
  } catch (error) {
    finish({ ...seen, error });
    throw error;
  }
}

interface Seen {
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

async function requestJson(request: GeminiJsonRequest, seen: Seen): Promise<GeminiJsonResult> {
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const { model, apiKey, timeoutMs = GEMINI_TIMEOUT_MS } = request;
  const url = generateContentUrl(model);
  const body = {
    systemInstruction: { parts: [{ text: request.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: request.text }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: request.responseSchema,
      temperature: 0,
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new SourceError(
      "network",
      GEMINI_SLUG,
      `Request to Gemini ${model} failed: ${redact(messageOf(cause), apiKey)}`,
      { cause },
    );
  }

  const { status } = response;
  seen.httpStatus = status;
  if (status === 401 || status === 403 || status === 429) {
    throw new SourceError("blocked", GEMINI_SLUG, `Gemini ${model} answered ${status}`, {
      status,
    });
  }
  if (!response.ok) {
    throw new SourceError("http", GEMINI_SLUG, `Gemini ${model} answered ${status}`, { status });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new SourceError("unparseable", GEMINI_SLUG, `Gemini ${model} answered with non-JSON`, {
      cause,
    });
  }

  const parsed = responseSchema.safeParse(raw);
  const usage = parsed.success ? parsed.data.usageMetadata : undefined;
  if (usage !== undefined) {
    seen.inputTokens = usage.promptTokenCount ?? 0;
    // Thinking tokens are billed at the output rate.
    seen.outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  }
  const text = parsed.success ? parsed.data.candidates?.[0]?.content?.parts?.[0]?.text : undefined;
  if (text === undefined) {
    throw new SourceError("unparseable", GEMINI_SLUG, `Gemini ${model} returned no candidate text`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new SourceError("unparseable", GEMINI_SLUG, `Gemini ${model} returned non-JSON text`, {
      cause,
    });
  }

  return {
    json,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      thinkingTokens: usage?.thoughtsTokenCount ?? 0,
    },
    model: (parsed.success ? parsed.data.modelVersion : undefined) ?? model,
    raw,
  };
}
