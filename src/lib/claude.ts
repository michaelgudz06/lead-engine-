import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { CLAUDE_EFFORT, CLAUDE_MODEL, requireEnv } from "./env";
import { addUsage } from "./repo/leads";

/**
 * The single place the app talks to Claude.
 *
 * Fixed by the owner: model claude-haiku-5-5 at effort "low" (CLAUDE_MODEL and
 * CLAUDE_EFFORT in env.ts). Nothing here accepts a model or effort override, so
 * no caller can reach for a bigger model by accident. Sampling parameters and
 * thinking budgets are never sent: this API version rejects them.
 *
 * Haiku 5.5 has no server-side refusal fallback, so a refusal is surfaced as a
 * ClaudeError and the caller treats that step as failed and moves on.
 */

export type ClaudeErrorKind =
  | "config" // no API key, or the key was rejected
  | "refusal" // stop_reason "refusal"
  | "max_tokens" // output cut off, even after one larger retry
  | "parse" // structured output did not match the schema
  | "rate_limit" // 429 after the SDK's retry
  | "overloaded" // 529 / 5xx after the SDK's retry
  | "timeout"
  | "aborted"
  | "bad_request"
  | "api";

export class ClaudeError extends Error {
  constructor(
    public readonly kind: ClaudeErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ClaudeError";
  }
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const DEFAULT_MAX_TOKENS = 8_000;
/** Adaptive thinking shares max_tokens with the answer, so the retry after a cut-off doubles it, up to this. */
const MAX_TOKENS_CEILING = 32_000;
const DEFAULT_TIMEOUT_MS = 90_000;

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    let apiKey: string;
    try {
      apiKey = requireEnv("ANTHROPIC_API_KEY");
    } catch (err) {
      throw new ClaudeError("config", err instanceof Error ? err.message : "ANTHROPIC_API_KEY is not set");
    }
    // maxRetries 1: the SDK retries once on 429, 529/5xx and connection errors,
    // honouring retry-after. More retries would blow the run's time budget.
    client = new Anthropic({ apiKey, maxRetries: 1, timeout: DEFAULT_TIMEOUT_MS });
  }
  return client;
}

/** Maps SDK errors to ClaudeError using the typed classes, most specific first. Never includes headers or keys. */
export function toClaudeError(err: unknown, label: string): ClaudeError {
  if (err instanceof ClaudeError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ClaudeError("aborted", `${label}: stopped (time budget used up)`);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeError("timeout", `${label}: Claude did not answer in time`);
  if (err instanceof Anthropic.APIConnectionError) return new ClaudeError("api", `${label}: could not reach the Claude API`);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError("config", `${label}: the Claude API key was rejected (check ANTHROPIC_API_KEY)`, err.status);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ClaudeError("rate_limit", `${label}: Claude rate limit reached, try again in a minute`, 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ClaudeError("bad_request", `${label}: Claude rejected the request (${short(err.message)})`, 400);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ClaudeError("overloaded", `${label}: Claude is overloaded or unavailable (HTTP ${err.status})`, err.status);
  }
  if (err instanceof Anthropic.APIError) {
    return new ClaudeError("api", `${label}: Claude API error ${err.status ?? ""} (${short(err.message)})`.trim(), err.status);
  }
  // Not an API error: the SDK throws a plain AnthropicError when the reply is not valid for the schema.
  if (err instanceof Anthropic.AnthropicError) return new ClaudeError("parse", `${label}: ${short(err.message)}`);
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ClaudeError("timeout", `${label}: timed out`);
  }
  return new ClaudeError("api", `${label}: ${short(err instanceof Error ? err.message : String(err))}`);
}

function short(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 240);
}

type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

function readUsage(usage: UsageLike | null | undefined): ClaudeUsage {
  return {
    // input_tokens excludes cached tokens; add them so the counter reflects everything sent.
    inputTokens:
      (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    calls: 1,
  };
}

/** Adds a call's tokens to the lead's running totals. Accounting must never fail a research step. */
async function recordUsage(leadId: string | null | undefined, usage: ClaudeUsage): Promise<void> {
  if (!leadId) return;
  try {
    await addUsage(leadId, {
      claudeInputTokens: usage.inputTokens,
      claudeOutputTokens: usage.outputTokens,
      claudeCalls: usage.calls,
    });
  } catch {
    // The numbers are informational; losing one update is better than losing the run.
  }
}

/** Below this much time left, a (second) attempt is not started. */
const MIN_ATTEMPT_MS = 3_000;

export interface GenerateObjectOptions<S extends z.ZodType> {
  /** Usage is added to this lead's counters. Omit for calls that belong to no lead. */
  leadId?: string | null;
  /** Short name for error messages, e.g. "Writing the brief". */
  label: string;
  system: string;
  prompt: string;
  /** zod v4 schema. Avoid numeric/string length constraints: the API ignores them and the SDK then enforces them client-side. */
  schema: S;
  maxTokens?: number;
  /** Wall-clock limit for the whole call, retries included. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One structured-output call. Returns the parsed, schema-validated object and
 * throws ClaudeError otherwise (refusal, cut-off, schema mismatch, API failure).
 * A cut-off or unparseable reply is retried once with twice the token budget,
 * because with adaptive thinking the usual cause is thinking eating the budget.
 */
export async function generateObject<S extends z.ZodType>(opts: GenerateObjectOptions<S>): Promise<z.infer<S>> {
  const { leadId, label, system, prompt, schema, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  let maxTokens = Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CEILING);
  let lastError: ClaudeError | null = null;

  // timeoutMs covers the whole call: the SDK's own retry and the larger second attempt
  // included. The SDK's `timeout` option is per HTTP attempt, so the cap is an abort signal.
  const stopAt = Date.now() + timeoutMs;

  for (let attempt = 0; attempt < 2; attempt++) {
    const left = stopAt - Date.now();
    if (left < MIN_ATTEMPT_MS) throw lastError ?? new ClaudeError("timeout", `${label}: timed out`);
    const cap = AbortSignal.timeout(left);
    let message;
    try {
      message = await anthropic().messages.parse(
        {
          model: CLAUDE_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: prompt }],
          output_config: { effort: CLAUDE_EFFORT, format: zodOutputFormat(schema) },
        },
        { timeout: left, signal: signal ? AbortSignal.any([signal, cap]) : cap },
      );
    } catch (err) {
      const mapped = toClaudeError(err, label);
      // A parse failure here usually means the JSON was cut off at max_tokens: retry once, larger.
      if (mapped.kind === "parse" && attempt === 0 && maxTokens < MAX_TOKENS_CEILING) {
        lastError = mapped;
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
        continue;
      }
      throw mapped;
    }

    await recordUsage(leadId, readUsage(message.usage));

    if (message.stop_reason === "refusal") {
      throw new ClaudeError("refusal", `${label}: Claude declined this request`);
    }
    if (message.stop_reason === "max_tokens") {
      lastError = new ClaudeError("max_tokens", `${label}: the answer was cut off (max_tokens ${maxTokens})`);
      if (attempt === 0 && maxTokens < MAX_TOKENS_CEILING) {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
        continue;
      }
      throw lastError;
    }
    if (message.parsed_output == null) {
      throw new ClaudeError("parse", `${label}: Claude returned no structured output (stop_reason ${message.stop_reason})`);
    }
    return message.parsed_output as z.infer<S>;
  }
  throw lastError ?? new ClaudeError("api", `${label}: no result`);
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  /** Returns the text Claude sees. Throwing is fine: the error text is passed back as the tool result. */
  run: (input: z.infer<S>) => Promise<string>;
  /**
   * Counts against maxToolCalls. Set false for cheap bookkeeping tools (such as
   * recording a finding) that should stay available after the budget is spent.
   */
  countsTowardBudget?: boolean;
}

/** Keeps the input type of each tool tied to its schema when building a tools array. */
export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

export interface ToolAgentOptions {
  leadId?: string | null;
  label: string;
  system: string;
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools with different input schemas share one array
  tools: AgentTool<any>[];
  /** Budgeted tool calls allowed in the whole run. Default 8. */
  maxToolCalls?: number;
  /** API requests allowed in the loop. Default maxToolCalls + 3. */
  maxIterations?: number;
  /** max_tokens per turn. */
  maxTokens?: number;
  /** Wall-clock limit for the whole loop. */
  timeoutMs?: number;
  /** Called before each tool runs, for progress events. Must not throw. */
  onToolCall?: (name: string, input: unknown) => void | Promise<void>;
}

export interface ToolAgentResult {
  /** The model's last text, usually a short summary of what it found. */
  text: string;
  stopReason: string | null;
  iterations: number;
  toolCalls: number;
  /** "completed" = the model stopped by itself. Other values mean the loop was cut short; anything the tools saved is kept. */
  outcome: "completed" | "iteration_cap" | "timeout" | "refusal" | "max_tokens" | "error";
  error?: string;
  usage: ClaudeUsage;
}

/**
 * A capped tool loop on the beta Tool Runner. Never throws: a refusal, timeout
 * or API failure ends the loop and is reported in `outcome`, because side effects
 * of earlier tool calls (saved findings) are still valid.
 */
export async function runToolAgent(opts: ToolAgentOptions): Promise<ToolAgentResult> {
  const { leadId, label, system, prompt, tools, onToolCall } = opts;
  const maxToolCalls = opts.maxToolCalls ?? 8;
  const maxIterations = opts.maxIterations ?? maxToolCalls + 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const result: ToolAgentResult = {
    text: "",
    stopReason: null,
    iterations: 0,
    toolCalls: 0,
    outcome: "completed",
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let budgetedCalls = 0;

  const runnable = tools.map((tool) =>
    betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (input) => {
        if (controller.signal.aborted) return "Out of time. Stop calling tools and give your final summary.";
        const counts = tool.countsTowardBudget !== false;
        if (counts && budgetedCalls >= maxToolCalls) {
          // Enforced here as well as in the prompt: a model that ignores the cap still cannot spend more.
          return "Tool budget used up. Do not call more search tools. Record any remaining findings and give your final summary.";
        }
        if (counts) budgetedCalls++;
        result.toolCalls++;
        try {
          await onToolCall?.(tool.name, input);
        } catch {
          // Progress reporting is best-effort.
        }
        try {
          return await tool.run(input);
        } catch (err) {
          return `Tool error: ${short(err instanceof Error ? err.message : String(err))}. Try something else or finish.`;
        }
      },
    }),
  );

  try {
    const runner = anthropic().beta.messages.toolRunner(
      {
        model: CLAUDE_MODEL,
        max_tokens: opts.maxTokens ?? 4_000,
        system,
        messages: [{ role: "user", content: prompt }],
        tools: runnable,
        output_config: { effort: CLAUDE_EFFORT },
        max_iterations: maxIterations,
        // Plain stateless requests with the full history: no dependency on the threads beta.
        thread: false,
      },
      { signal: controller.signal },
    );

    for await (const message of runner) {
      result.iterations++;
      const usage = readUsage(message.usage);
      result.usage.inputTokens += usage.inputTokens;
      result.usage.outputTokens += usage.outputTokens;
      result.usage.calls += 1;
      result.stopReason = message.stop_reason;
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
      if (text) result.text = text;
      // A refusal can cut a tool_use off mid-input: stop before the runner executes that turn's tools.
      if (message.stop_reason === "refusal") {
        result.outcome = "refusal";
        break;
      }
      if (message.stop_reason === "max_tokens") {
        result.outcome = "max_tokens";
        break;
      }
    }
    // The runner stops silently at max_iterations; a last turn that still asked for tools means it was capped.
    if (result.outcome === "completed" && result.stopReason === "tool_use") result.outcome = "iteration_cap";
  } catch (err) {
    const mapped = toClaudeError(err, label);
    result.outcome = mapped.kind === "aborted" || mapped.kind === "timeout" ? "timeout" : mapped.kind === "refusal" ? "refusal" : "error";
    result.error = mapped.message;
  } finally {
    clearTimeout(timer);
  }

  if (result.usage.calls) await recordUsage(leadId, result.usage);
  return result;
}

/** For the status endpoint and scripts: which model the app runs. */
export function claudeModelInfo(): { name: string; effort: string } {
  return { name: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
}
