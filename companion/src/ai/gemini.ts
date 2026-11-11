import { FetchLike, postJson } from "./http";
import { AiError, AiProvider, AiRequest, AiResponse } from "./provider";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/** Google Gemini via the generateContent REST endpoint, in JSON mode. */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  readonly model: string;
  private schemaSupported = true;

  constructor(private readonly options: GeminiOptions) {
    this.model = options.model;
  }

  async generate(request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const base = (this.options.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const url = `${base}/models/${encodeURIComponent(this.model)}:generateContent`;
    const call = () =>
      postJson(
        "Gemini",
        url,
        // The key goes in a header, never in the URL, so it cannot end up in logs or proxies' access logs.
        { "x-goog-api-key": this.options.apiKey },
        {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: "application/json",
            ...(this.schemaSupported ? { responseJsonSchema: request.jsonSchema } : {}),
          },
        },
        this.options.timeoutMs,
        this.options.fetchImpl,
        signal,
      );
    let data: any;
    try {
      data = await call();
    } catch (error) {
      // Older models / proxies reject the schema field; plain JSON mode still works (the prompt describes the fields).
      if (error instanceof AiError && error.status === 400 && this.schemaSupported && /schema|unknown name/i.test(error.message)) {
        this.schemaSupported = false;
        data = await call();
      } else throw error;
    }
    const blocked = data?.promptFeedback?.blockReason;
    if (blocked) throw new AiError("refusal", `Gemini blocked the request (${blocked}).`, false);
    const candidate = data?.candidates?.[0];
    const text: string = (candidate?.content?.parts ?? [])
      .filter((p: any) => typeof p?.text === "string" && !p.thought)
      .map((p: any) => p.text)
      .join("");
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new AiError("malformed", "Gemini ran out of output tokens. Increase ai.maxOutputTokens in config.json.", false);
    }
    if (candidate?.finishReason === "SAFETY") {
      throw new AiError("refusal", "Gemini stopped for safety reasons.", false);
    }
    const usage = data?.usageMetadata;
    return {
      text,
      usage: usage
        ? {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          }
        : undefined,
    };
  }
}
