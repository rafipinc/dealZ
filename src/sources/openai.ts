// OpenAI client for the model-assisted price history (ADR-0020). The only
// file in DealZ that knows the shape of OpenAI's Responses API, so swapping
// the provider means swapping this file. One prompt in, with the web search
// tool fenced to the retailers' domains; the model's text and the searches it
// made out. The text is evidence for the caller to check, never a price fact
// (ADR-0013). Every failure is a SourceError under the "openai" slug so the
// caller can tell a model outage from a retailer problem.

import { z } from "zod";
import { beginCall, readClock, report } from "./meter";
import { SourceError, type FetchLike, type Meter } from "./types";

export const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
/** SourceError.retailerSlug for failures of the model service itself. */
export const OPENAI_SLUG = "openai";
/** The model that searches by default. Confirmed on the models list on 2026-10-13. */
export const DEFAULT_HISTORY_MODEL = "gpt-6-luna";
/** A search run reads several pages before it answers; the live probe of 2026-10-13 took 28 s. */
export const OPENAI_TIMEOUT_MS = 90_000;

export interface OpenAiHistoryRequest {
  model: string;
  apiKey: string;
  /** The user turn: what to find and the rules for reporting it. */
  prompt: string;
  /** The web search tool may open these domains and no others. */
  allowedDomains: string[];
  /** Upper bound on searches and page opens in one response. Each is billed. */
  maxToolCalls: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Clock for the meter's timing. Defaults to () => new Date(). */
  now?: () => Date;
  /** Told about the request, with its token counts, and about every search the model made. */
  meter?: Meter;
  /** A history search spans retailers, so the meter's retailer is always null. */
  retailerSlug?: null;
}

/** One search or page open the model made while answering. */
export interface OpenAiToolCall {
  /** "other" for an action this file does not know; kept so the count is right. */
  type: "search" | "open_page" | "other";
  /** The search terms, for a search. */
  query: string | null;
  /** The page opened, for an open_page. */
  url: string | null;
}

export interface OpenAiHistoryResult {
  /** The model's answer, every text part joined. Callers parse and validate it. */
  text: string;
  /** Every web_search_call item, in order. */
  toolCalls: OpenAiToolCall[];
  /** The model the service reports, or the requested model when it reports none. */
  model: string;
  inputTokens: number;
  /** Everything billed as output, reasoning tokens included. */
  outputTokens: number;
  /** The response body as received, with the key removed should it ever appear. Never the request. */
  raw: unknown;
}

const count = z.number().catch(0);

const responseSchema = z.looseObject({
  model: z.string().optional(),
  status: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).nullable().optional(),
  usage: z
    .looseObject({ input_tokens: count.optional(), output_tokens: count.optional() })
    .optional(),
  output: z.array(z.unknown()).optional(),
});

/**
 * Output items are read one by one, so an item of a kind this file does not
 * know ("reasoning", or whatever the provider adds next) is skipped alone.
 * The sources of a search are kept in `raw`; nothing here reads them.
 */
const webSearchCallSchema = z.looseObject({
  type: z.literal("web_search_call"),
  action: z
    .looseObject({
      type: z.string().optional(),
      query: z.string().optional(),
      url: z.string().optional(),
      sources: z.array(z.looseObject({ url: z.string().optional() })).optional(),
    })
    .optional(),
});

const messageSchema = z.looseObject({
  type: z.literal("message"),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
});

/** An error message with the key removed, in case a runtime echoes headers. */
function redact(message: string, apiKey: string): string {
  return apiKey.length === 0 ? message : message.split(apiKey).join("REDACTED");
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toolCallOf(item: unknown): OpenAiToolCall | null {
  const parsed = webSearchCallSchema.safeParse(item);
  if (!parsed.success) return null;
  const action = parsed.data.action;
  const type = action?.type === "search" || action?.type === "open_page" ? action.type : "other";
  return { type, query: action?.query ?? null, url: action?.url ?? null };
}

/** The output_text parts of a message item, or null for any other item. */
function textsOf(item: unknown): string[] | null {
  const parsed = messageSchema.safeParse(item);
  if (!parsed.success) return null;
  return (parsed.data.content ?? []).flatMap((part) =>
    part.type === "output_text" && part.text !== undefined ? [part.text] : [],
  );
}

/**
 * Asks the model to search the allowed domains and answer the prompt.
 * Throws SourceError: "network" when the request fails or times out,
 * "blocked" on 401, 403 or 429, "http" on any other non-2xx status or an
 * error object in the body, and "unparseable" when the body is not JSON,
 * the response did not complete or it carries no message text.
 */
export async function searchHistory(request: OpenAiHistoryRequest): Promise<OpenAiHistoryResult> {
  // The meter is told the model that was asked for, not the version the
  // service reports, so the price table has one stable name to look up.
  const finish = beginCall(request.meter, request.now, {
    provider: "openai",
    operation: "responses",
    retailerSlug: null,
    model: request.model,
  });
  // Filled in as the response is read, so a call that fails late still
  // reports the status, the tokens and the searches it was billed for.
  const seen: Seen = { httpStatus: null, inputTokens: null, outputTokens: null, toolCalls: [] };
  try {
    const result = await requestHistory(request, seen);
    finish(callResultOf(seen));
    return result;
  } catch (error) {
    finish({ ...callResultOf(seen), error });
    throw error;
  } finally {
    reportToolCalls(request, seen.toolCalls);
  }
}

interface Seen {
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Read before the status is judged: a response cut short was still billed for its searches. */
  toolCalls: OpenAiToolCall[];
}

function callResultOf(seen: Seen) {
  const { httpStatus, inputTokens, outputTokens } = seen;
  return { httpStatus, inputTokens, outputTokens };
}

/**
 * One ledger row per search or page open. The provider bills per search
 * query, not per page opened: the recorded S85H response has
 * `tool_usage.web_search.num_requests` 3 against five web_search_call items,
 * three searches and two page opens. So a search is a "web_search_call" row,
 * priced per call, and a page open or any other action is a
 * "web_search_open_page" row, priced at zero, so the ledger counts every
 * action and charges only the searches. They happened inside the one
 * request, so each is dated when the answer was read and takes no time of
 * its own.
 */
function reportToolCalls(request: OpenAiHistoryRequest, toolCalls: OpenAiToolCall[]): void {
  const { meter } = request;
  if (meter === undefined || toolCalls.length === 0) return;
  const startedAt = readClock(request.now ?? (() => new Date()));
  for (const call of toolCalls) {
    report(meter, {
      provider: "openai",
      operation: call.type === "search" ? "web_search_call" : "web_search_open_page",
      startedAt,
      durationMs: 0,
      outcome: "ok",
      errorKind: null,
      httpStatus: null,
      model: request.model,
      inputTokens: null,
      outputTokens: null,
      retailerSlug: null,
    });
  }
}

async function requestHistory(
  request: OpenAiHistoryRequest,
  seen: Seen,
): Promise<OpenAiHistoryResult> {
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const { model, apiKey, timeoutMs = OPENAI_TIMEOUT_MS } = request;
  const body = {
    model,
    max_tool_calls: request.maxToolCalls,
    tools: [{ type: "web_search", filters: { allowed_domains: request.allowedDomains } }],
    include: ["web_search_call.action.sources"],
    input: request.prompt,
  };

  let response: Response;
  try {
    response = await fetchImpl(OPENAI_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new SourceError(
      "network",
      OPENAI_SLUG,
      `Request to OpenAI ${model} failed: ${redact(messageOf(cause), apiKey)}`,
      { cause },
    );
  }

  const { status } = response;
  seen.httpStatus = status;
  if (status === 401 || status === 403 || status === 429) {
    throw new SourceError("blocked", OPENAI_SLUG, `OpenAI ${model} answered ${status}`, {
      status,
    });
  }
  if (!response.ok) {
    throw new SourceError("http", OPENAI_SLUG, `OpenAI ${model} answered ${status}`, { status });
  }

  // The body is read as text and the key removed before it is parsed, so
  // neither `raw` nor an error built from it can carry the key.
  let text: string;
  try {
    text = redact(await response.text(), apiKey);
  } catch (cause) {
    throw new SourceError("network", OPENAI_SLUG, `Body of OpenAI ${model} could not be read`, {
      cause,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new SourceError("unparseable", OPENAI_SLUG, `OpenAI ${model} answered with non-JSON`, {
      cause,
    });
  }

  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SourceError(
      "unparseable",
      OPENAI_SLUG,
      `OpenAI ${model} answered with an unexpected shape`,
      { cause: parsed.error },
    );
  }
  const { data } = parsed;
  if (data.usage !== undefined) {
    seen.inputTokens = data.usage.input_tokens ?? 0;
    // Reasoning tokens are inside output_tokens already, billed at the output rate.
    seen.outputTokens = data.usage.output_tokens ?? 0;
  }
  if (data.error !== undefined && data.error !== null) {
    throw new SourceError(
      "http",
      OPENAI_SLUG,
      `OpenAI ${model} answered ${status} with an error: ${data.error.message ?? "no message"}`,
      { status },
    );
  }

  const output = data.output ?? [];
  seen.toolCalls = output.flatMap((item) => {
    const call = toolCallOf(item);
    return call === null ? [] : [call];
  });
  if (data.status !== "completed") {
    throw new SourceError(
      "unparseable",
      OPENAI_SLUG,
      `OpenAI ${model} answered with status ${data.status ?? "unknown"}, not completed`,
    );
  }
  const texts = output.flatMap((item) => textsOf(item) ?? []);
  if (texts.length === 0) {
    throw new SourceError("unparseable", OPENAI_SLUG, `OpenAI ${model} returned no message text`);
  }

  return {
    text: texts.join("\n"),
    toolCalls: seen.toolCalls,
    model: data.model ?? model,
    inputTokens: seen.inputTokens ?? 0,
    outputTokens: seen.outputTokens ?? 0,
    raw,
  };
}
