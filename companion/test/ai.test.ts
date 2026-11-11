import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../src/ai/gemini";
import { extractJson, parseAiJson, repairJson } from "../src/ai/json";
import { OpenAiProvider } from "../src/ai/openai";
import { AiError, errorFromStatus, withRetries } from "../src/ai/provider";
import { VerdictSchema } from "../src/engine";
import { Limiter, LimitError } from "../src/limits";

const REQ = { system: "sys", user: "usr", jsonSchema: { type: "object" }, schemaName: "verdict", maxOutputTokens: 500 };

describe("grader JSON parsing", () => {
  it("parses a strict verdict", () => {
    expect(parseAiJson('{"correct": true, "score": 1, "explanation": "Yes."}', VerdictSchema)).toEqual({
      correct: true,
      score: 1,
      explanation: "Yes.",
    });
  });

  it("tolerates code fences and surrounding chatter", () => {
    const text = 'Sure! Here is the verdict:\n```json\n{"correct": false, "score": 0.5, "explanation": "Half."}\n```\nHope that helps.';
    expect(parseAiJson(text, VerdictSchema).score).toBe(0.5);
    expect(extractJson('noise {"a": 1} trailing')).toBe('{"a": 1}');
  });

  it("repairs LaTeX backslashes, raw newlines and trailing commas", () => {
    const broken = '{"correct": false, "score": 0, "explanation": "Use \\frac{1}{2} and \\theta, not \\(x\\).\nSecond line",}';
    expect(() => JSON.parse(broken)).toThrow();
    const v = parseAiJson(broken, VerdictSchema);
    expect(v.explanation).toBe("Use \\frac{1}{2} and \\theta, not \\(x\\).\nSecond line");
  });

  it("keeps genuine escapes when repairing", () => {
    const repaired = JSON.parse(repairJson('{"a": "line1\\nline2 \\"quoted\\" \\u00e9 tab\\there \\alpha"}'));
    expect(repaired.a).toBe('line1\nline2 "quoted" é tab\there \\alpha');
  });

  it("rejects schema violations with a description usable for a retry", () => {
    const bad = () => parseAiJson('{"correct": "yes", "score": 1}', VerdictSchema);
    expect(bad).toThrow(AiError);
    try {
      bad();
    } catch (e) {
      expect((e as AiError).kind).toBe("malformed");
      expect((e as AiError).message).toMatch(/correct/);
      expect((e as AiError).message).toMatch(/explanation/);
    }
  });

  it("rejects non-JSON", () => {
    expect(() => parseAiJson("I cannot answer that.", VerdictSchema)).toThrow(/not valid JSON/);
  });
});

describe("error classification", () => {
  it("maps HTTP statuses to actionable errors", () => {
    expect(errorFromStatus("OpenAI", 401, "bad key").kind).toBe("auth");
    expect(errorFromStatus("OpenAI", 401, "bad key").retryable).toBe(false);
    expect(errorFromStatus("OpenAI", 429, '{"error":{"code":"insufficient_quota"}}').kind).toBe("quota");
    expect(errorFromStatus("OpenAI", 429, "slow down").kind).toBe("rate_limit");
    expect(errorFromStatus("Gemini", 503, "overloaded").retryable).toBe(true);
    expect(errorFromStatus("Gemini", 404, "no such model").message).toMatch(/ai\.model/);
    expect(errorFromStatus("Gemini", 400, "bad").retryable).toBe(false);
  });

  it("retries retryable errors with backoff and gives up on fatal ones", async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetries(
      async () => {
        if (++calls < 3) throw new AiError("server", "boom", true);
        return "ok";
      },
      { maxRetries: 3, sleep: async (ms) => void delays.push(ms) },
    );
    expect(value).toBe("ok");
    expect(delays.length).toBe(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]! * 0.9);

    calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new AiError("auth", "bad key", false);
        },
        { maxRetries: 3, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new AiError("network", "down", true);
        },
        { maxRetries: 2, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ kind: "network" });
    expect(calls).toBe(3);
  });
});

function fakeFetch(handler: (url: string, init: any) => { status: number; body: unknown }): { fetchImpl: typeof fetch; calls: { url: string; init: any; body: any }[] } {
  const calls: { url: string; init: any; body: any }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const { status, body } = handler(String(url), init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("OpenAI provider", () => {
  it("sends a strict JSON schema request and returns text + usage", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    }));
    const p = new OpenAiProvider({ apiKey: "sk-secret", model: "gpt-test", timeoutMs: 5000, fetchImpl, baseUrl: "https://proxy.example/v1/" });
    const r = await p.generate(REQ);
    expect(r).toEqual({ text: '{"ok":true}', usage: { inputTokens: 11, outputTokens: 7 } });
    expect(calls[0]!.url).toBe("https://proxy.example/v1/chat/completions");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer sk-secret");
    expect(calls[0]!.body.response_format.type).toBe("json_schema");
    expect(calls[0]!.body.response_format.json_schema.strict).toBe(true);
  });

  it("falls back to json_object for endpoints without json_schema support", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch(() =>
      ++n === 1
        ? { status: 400, body: { error: { message: "response_format json_schema is not supported" } } }
        : { status: 200, body: { choices: [{ message: { content: "{}" } }] } },
    );
    const p = new OpenAiProvider({ apiKey: "k", model: "m", timeoutMs: 5000, fetchImpl });
    await p.generate(REQ);
    expect(calls[1]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("reports a bad key clearly and without echoing it", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { error: { message: "Incorrect API key provided" } } }));
    const p = new OpenAiProvider({ apiKey: "sk-very-secret-value", model: "m", timeoutMs: 5000, fetchImpl });
    const error = await p.generate(REQ).catch((e) => e as AiError);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("auth");
    expect((error as AiError).message).toMatch(/ai\.apiKey/);
    expect((error as AiError).message).not.toContain("sk-very-secret-value");
  });

  it("reports network failures", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api" } });
    }) as unknown as typeof fetch;
    const p = new OpenAiProvider({ apiKey: "k", model: "m", timeoutMs: 5000, fetchImpl });
    await expect(p.generate(REQ)).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});

describe("Gemini provider", () => {
  it("sends the key in a header (never the URL) and joins text parts", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"a":' }, { text: "1}" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
      },
    }));
    const p = new GeminiProvider({ apiKey: "AIza-secret", model: "gemini-test", timeoutMs: 5000, fetchImpl });
    const r = await p.generate(REQ);
    expect(r).toEqual({ text: '{"a":1}', usage: { inputTokens: 5, outputTokens: 5 } });
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(calls[0]!.url).not.toContain("AIza");
    expect(calls[0]!.init.headers["x-goog-api-key"]).toBe("AIza-secret");
    expect(calls[0]!.body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("classifies quota errors", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 429, body: { error: { message: "Quota exceeded, check billing" } } }));
    const p = new GeminiProvider({ apiKey: "k", model: "m", timeoutMs: 5000, fetchImpl });
    await expect(p.generate(REQ)).rejects.toMatchObject({ kind: "quota" });
  });
});

describe("limiter", () => {
  const cfg = { requestsPerMinute: 3, perPlayerRequestsPerMinute: 2, maxRequestsPerDay: 5, maxConcurrentRequests: 1, dailyTokenBudget: 100 };

  it("enforces per-player and global rates over a sliding minute", () => {
    let now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const l = new Limiter(cfg, () => now);
    l.check("a");
    l.check("a");
    expect(() => l.check("a")).toThrow(LimitError);
    l.check("b");
    expect(() => l.check("c")).toThrow(/busy/);
    now += 61_000;
    l.check("a");
  });

  it("enforces daily request and token caps and resets the next day", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const l = new Limiter({ ...cfg, requestsPerMinute: 100, perPlayerRequestsPerMinute: 100 }, () => now);
    for (let i = 0; i < 5; i++) l.check("a");
    expect(() => l.check("a")).toThrow(/limit is used up/);
    now += 24 * 3600_000;
    l.check("a");
    l.recordTokens(150);
    expect(() => l.check("a")).toThrow(/token budget/);
  });

  it("limits concurrency", async () => {
    const l = new Limiter(cfg);
    let active = 0;
    let peak = 0;
    const job = () =>
      l.run(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([job(), job(), job()]);
    expect(peak).toBe(1);
  });
});
