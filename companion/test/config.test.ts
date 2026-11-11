import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, KEY_OVERRIDE_ENV, parseConfig } from "../src/config";
import { Logger } from "../src/logger";

const dir = mkdtempSync(path.join(tmpdir(), "censor-config-"));
const base = () => ({
  ai: { provider: "claude", model: "claude-opus-5-5", apiKey: "sk-test-1234567890abcdef" },
  courseFolder: "",
});

function problems(raw: unknown, env: NodeJS.ProcessEnv = {}): string {
  try {
    parseConfig(raw, env, dir);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems.join("\n");
  }
  throw new Error("expected the config to be rejected");
}

describe("config validation", () => {
  it("accepts a minimal config and applies defaults", () => {
    const cfg = parseConfig(base(), {}, dir);
    expect(cfg.websocket.port).toBe(8765);
    expect(cfg.ai.timeoutMs).toBe(60000);
    expect(cfg.ai.maxRetries).toBe(2);
    expect(cfg.limits.requestsPerMinute).toBe(20);
    expect(cfg.resolvedApiKey).toBe("sk-test-1234567890abcdef");
    expect(cfg.apiKeySource).toMatch(/config\.json/);
    expect(cfg.courseFolderAbs).toBe("");
  });

  it("names the bad field and the allowed values for a wrong provider", () => {
    const text = problems({ ...base(), ai: { ...base().ai, provider: "chatgpt" } });
    expect(text).toMatch(/ai\.provider/);
    expect(text).toMatch(/"claude", "gemini", "openai"/);
  });

  it("rejects wrong types and out-of-range values with the field name", () => {
    expect(problems({ ...base(), websocket: { port: 99999 } })).toMatch(/websocket\.port/);
    expect(problems({ ...base(), ai: { ...base().ai, timeoutMs: "fast" } })).toMatch(/ai\.timeoutMs/);
    expect(problems({ ...base(), ai: { ...base().ai, model: "" } })).toMatch(/ai\.model/);
    expect(problems({ ...base(), ai: { ...base().ai, baseUrl: "not a url" } })).toMatch(/ai\.baseUrl/);
    expect(problems({ courseFolder: "" })).toMatch(/ai/);
  });

  it("requires an API key unless the provider is mock", () => {
    expect(problems({ ...base(), ai: { provider: "openai", model: "gpt-x" } })).toMatch(/no API key found/);
    expect(problems({ ...base(), ai: { provider: "openai", model: "gpt-x", apiKey: "PASTE-YOUR-API-KEY-HERE" } })).toMatch(/no API key/);
    const mock = parseConfig({ ai: { provider: "mock", model: "mock" } }, {}, dir);
    expect(mock.resolvedApiKey).toBe("");
  });

  it("reads the key from the variable named by apiKeyEnv, which overrides the file", () => {
    const cfg = parseConfig({ ...base(), ai: { ...base().ai, apiKeyEnv: "MY_KEY" } }, { MY_KEY: "from-env-123456" }, dir);
    expect(cfg.resolvedApiKey).toBe("from-env-123456");
    expect(cfg.apiKeySource).toBe("environment variable MY_KEY");
    // The source description never contains the key itself.
    expect(cfg.apiKeySource).not.toContain("from-env");
  });

  it("falls back to the file key when the named variable is unset, and lets CENSOR_AI_API_KEY win", () => {
    const raw = { ...base(), ai: { ...base().ai, apiKeyEnv: "MY_KEY" } };
    expect(parseConfig(raw, {}, dir).resolvedApiKey).toBe("sk-test-1234567890abcdef");
    expect(parseConfig(raw, { MY_KEY: "a-key-000000", [KEY_OVERRIDE_ENV]: "override-999999" }, dir).resolvedApiKey).toBe("override-999999");
  });

  it("treats empty optional strings as unset", () => {
    const cfg = parseConfig({ ...base(), ai: { ...base().ai, baseUrl: "", apiKeyEnv: "", effort: "" } }, {}, dir);
    expect(cfg.ai.baseUrl).toBeUndefined();
    expect(cfg.ai.effort).toBeUndefined();
  });

  it("checks that the course folder exists and that topic folders are relative", () => {
    expect(problems({ ...base(), courseFolder: "does-not-exist-xyz" })).toMatch(/courseFolder: .*does not exist/);
    expect(problems({ ...base(), topicFolders: { Calc: "../secrets" } })).toMatch(/topicFolders\["Calc"\]/);
    const ok = parseConfig({ ...base(), courseFolder: "." }, {}, dir);
    expect(ok.courseFolderAbs).toBe(dir);
  });
});

describe("logger redaction", () => {
  it("never prints a registered secret or key-shaped tokens", () => {
    const lines: string[] = [];
    const log = new Logger("debug", (l) => lines.push(l));
    log.addSecret("super-secret-key-value");
    log.error("request failed with key super-secret-key-value in header");
    log.info("another sk-abcdefgh12345678901234567890 token and AIzaSyA1234567890abcdefghijklmn");
    const out = lines.join("\n");
    expect(out).not.toContain("super-secret-key-value");
    expect(out).not.toContain("12345678901234567890");
    expect(out).not.toContain("abcdefghijklmn");
    expect(out).toContain("[REDACTED]");
  });
});
