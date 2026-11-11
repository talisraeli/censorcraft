import Anthropic from "@anthropic-ai/sdk";
import { AiError, AiProvider, AiRequest, AiResponse } from "./provider";

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Models whose safety classifiers can decline a request and that support the
 * server-side `fallbacks: "default"` re-run (Claude API only, so it is skipped
 * when a custom baseUrl / proxy is configured).
 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ClaudeProvider implements AiProvider {
  readonly name = "claude";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly useFallbacks: boolean;

  constructor(private readonly options: ClaudeOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl || undefined,
      timeout: options.timeoutMs,
      // Retries are handled uniformly for all providers by withRetries().
      maxRetries: 0,
    });
    this.useFallbacks = !options.baseUrl && FALLBACK_MODELS.has(options.model);
  }

  async generate(request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    // Thinking is left at the model default (adaptive on current models);
    // depth is controlled with the optional ai.effort setting.
    const params = {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user" as const, content: request.user }],
      output_config: {
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        format: { type: "json_schema" as const, schema: request.jsonSchema },
      },
    };
    try {
      const response = this.useFallbacks
        ? await this.client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" }, { signal })
        : await this.client.messages.create(params, { signal });

      if (response.stop_reason === "refusal") {
        throw new AiError("refusal", "Claude declined this request (stop_reason: refusal). Try a different topic or material chunk.", false);
      }
      let text = "";
      for (const block of response.content) if (block.type === "text") text += block.text;
      if (response.stop_reason === "max_tokens") {
        throw new AiError(
          "malformed",
          "Claude ran out of output tokens before finishing. Increase ai.maxOutputTokens in config.json (or lower ai.effort).",
          false,
        );
      }
      return {
        text,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    } catch (error) {
      throw translate(error, this.options.timeoutMs);
    }
  }
}

function translate(error: unknown, timeoutMs: number): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiError("timeout", `Claude did not answer within ${timeoutMs} ms (ai.timeoutMs).`, true);
  }
  if (error instanceof Anthropic.APIUserAbortError) {
    return new AiError("timeout", "The request to Claude was cancelled.", false);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError("network", `Could not reach the Claude API: ${error.message}. Check your internet connection and ai.baseUrl.`, true);
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiError(
      "auth",
      `Claude rejected the API key (HTTP ${error.status}). Check ai.apiKey / ai.apiKeyEnv in config.json.`,
      false,
      error.status,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError("rate_limit", "Claude is rate limiting requests (HTTP 429).", true, 429);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new AiError("bad_request", `Claude returned 404: the model in ai.model is probably wrong. ${error.message}`, false, 404);
  }
  if (error instanceof Anthropic.BadRequestError) {
    const quota = /credit balance|billing/i.test(error.message);
    return new AiError(
      quota ? "quota" : "bad_request",
      quota
        ? `The Anthropic account is out of credit: ${error.message}`
        : `Claude rejected the request (HTTP 400): ${error.message}`,
      false,
      400,
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    return new AiError("server", `Claude API error${status ? ` (HTTP ${status})` : ""}: ${error.message}`, !status || status >= 500, status);
  }
  return new AiError("server", `Unexpected error calling Claude: ${(error as Error)?.message ?? String(error)}`, false);
}
