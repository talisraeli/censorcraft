/** Provider abstraction: one interface, three real implementations plus a mock. */

export interface AiRequest {
  /** Trusted instructions. */
  system: string;
  /** Request body. May contain delimited, untrusted data. */
  user: string;
  /** JSON Schema the answer must follow. */
  jsonSchema: Record<string, unknown>;
  /** Short identifier for the schema ("question" / "verdict"). */
  schemaName: string;
  maxOutputTokens: number;
}

export interface AiResponse {
  /** Raw model text; expected to be a JSON document. */
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate(request: AiRequest, signal?: AbortSignal): Promise<AiResponse>;
}

export type AiErrorKind =
  | "auth"
  | "quota"
  | "rate_limit"
  | "network"
  | "timeout"
  | "bad_request"
  | "server"
  | "refusal"
  | "malformed";

/** Normalized provider failure with a message that is safe to show to the user of the companion. */
export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** Map an HTTP status (+ body snippet) from any provider to an AiError. */
export function errorFromStatus(provider: string, status: number, body: string): AiError {
  const snippet = body.replace(/\s+/g, " ").slice(0, 300);
  const lower = snippet.toLowerCase();
  if (status === 401 || status === 403) {
    return new AiError(
      "auth",
      `${provider} rejected the API key (HTTP ${status}). Check ai.apiKey / ai.apiKeyEnv in config.json and that the key is valid for this provider. ${snippet}`,
      false,
      status,
    );
  }
  if (status === 402 || lower.includes("insufficient_quota") || lower.includes("credit balance") || lower.includes("billing")) {
    return new AiError(
      "quota",
      `${provider} reports that the account is out of quota or credit (HTTP ${status}). Check billing for this key. ${snippet}`,
      false,
      status,
    );
  }
  if (status === 429) {
    return new AiError("rate_limit", `${provider} is rate limiting requests (HTTP 429). ${snippet}`, true, status);
  }
  if (status === 404) {
    return new AiError(
      "bad_request",
      `${provider} returned 404. The model name in ai.model (or ai.baseUrl) is probably wrong. ${snippet}`,
      false,
      status,
    );
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new AiError("server", `${provider} had a temporary problem (HTTP ${status}). ${snippet}`, true, status);
  }
  return new AiError("bad_request", `${provider} rejected the request (HTTP ${status}). ${snippet}`, false, status);
}

export function errorFromNetwork(provider: string, error: unknown, timeoutMs: number): AiError {
  const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return new AiError("timeout", `${provider} did not answer within ${timeoutMs} ms (ai.timeoutMs).`, true);
  }
  const code = e?.cause?.code ?? "";
  return new AiError(
    "network",
    `Could not reach ${provider}: ${e?.cause?.message ?? e?.message ?? "network error"}${code ? ` (${code})` : ""}. Check your internet connection${code === "ENOTFOUND" ? " and ai.baseUrl" : ""}.`,
    true,
  );
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: AiError, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Retry retryable AiErrors with exponential backoff + jitter. */
export async function withRetries<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = options.baseDelayMs ?? 800;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const aiError = error instanceof AiError ? error : new AiError("server", String((error as Error)?.message ?? error), false);
      if (!aiError.retryable || attempt >= options.maxRetries) throw aiError;
      const delay = Math.round(base * 2 ** attempt * (0.75 + Math.random() * 0.5));
      options.onRetry?.(attempt + 1, aiError, delay);
      await sleep(delay);
    }
  }
}
