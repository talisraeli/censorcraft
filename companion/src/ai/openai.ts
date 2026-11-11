import { FetchLike, postJson } from "./http";
import { AiError, AiProvider, AiRequest, AiResponse } from "./provider";

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/**
 * OpenAI Chat Completions (also works with OpenAI-compatible endpoints through
 * ai.baseUrl). Uses strict JSON-schema structured output and transparently
 * falls back to plain JSON mode for endpoints that do not support it.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model: string;
  private jsonSchemaSupported = true;
  private tokenParam: "max_completion_tokens" | "max_tokens" = "max_completion_tokens";

  constructor(private readonly options: OpenAiOptions) {
    this.model = options.model;
  }

  async generate(request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const base = (this.options.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    for (let attempt = 0; ; attempt++) {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        [this.tokenParam]: request.maxOutputTokens,
        response_format: this.jsonSchemaSupported
          ? { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema } }
          : { type: "json_object" },
      };
      try {
        const data = await postJson(
          "OpenAI",
          `${base}/chat/completions`,
          { authorization: `Bearer ${this.options.apiKey}` },
          body,
          this.options.timeoutMs,
          this.options.fetchImpl,
          signal,
        );
        const choice = data?.choices?.[0];
        if (choice?.message?.refusal) {
          throw new AiError("refusal", `The model declined this request: ${String(choice.message.refusal).slice(0, 200)}`, false);
        }
        const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
        if (choice?.finish_reason === "length") {
          throw new AiError("malformed", "The model ran out of output tokens. Increase ai.maxOutputTokens in config.json.", false);
        }
        return {
          text,
          usage: data?.usage
            ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
            : undefined,
        };
      } catch (error) {
        // Compatibility downgrades for older / third-party endpoints (each tried once).
        if (error instanceof AiError && error.status === 400 && attempt < 2) {
          if (this.jsonSchemaSupported && /response_format|json_schema/i.test(error.message)) {
            this.jsonSchemaSupported = false;
            continue;
          }
          if (this.tokenParam === "max_completion_tokens" && /max_completion_tokens/i.test(error.message)) {
            this.tokenParam = "max_tokens";
            continue;
          }
        }
        throw error;
      }
    }
  }
}
