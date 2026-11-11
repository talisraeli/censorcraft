import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PROVIDERS = ["claude", "gemini", "openai", "mock"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Environment variable that always overrides the key in the file. */
export const KEY_OVERRIDE_ENV = "CENSOR_AI_API_KEY";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const AiSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1),
  apiKey: z.preprocess(emptyToUndefined, z.string().trim().optional()),
  apiKeyEnv: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  ),
  baseUrl: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  maxRetries: z.number().int().min(0).max(10).default(2),
  maxOutputTokens: z.number().int().min(256).max(64_000).default(8000),
  effort: z.preprocess(emptyToUndefined, z.enum(["low", "medium", "high", "xhigh", "max"]).optional()),
});

const ConfigSchema = z.object({
  ai: AiSchema,
  courseFolder: z.string().default(""),
  topicFolders: z.record(z.string(), z.string()).default({}),
  websocket: z
    .object({
      host: z.string().trim().min(1).default("localhost"),
      port: z.number().int().min(1).max(65535).default(8765),
    })
    .default({ host: "localhost", port: 8765 }),
  limits: z
    .object({
      requestsPerMinute: z.number().int().min(1).max(600).default(20),
      perPlayerRequestsPerMinute: z.number().int().min(1).max(600).default(8),
      maxRequestsPerDay: z.number().int().min(1).max(100_000).default(500),
      maxConcurrentRequests: z.number().int().min(1).max(16).default(2),
      /** 0 = unlimited. Counts input + output tokens reported by the provider. */
      dailyTokenBudget: z.number().int().min(0).default(0),
      maxMaterialChars: z.number().int().min(500).max(40_000).default(6000),
    })
    .prefault({}),
  session: z.object({ idleTimeoutMinutes: z.number().min(1).max(1440).default(30) }).prefault({}),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type FileConfig = z.infer<typeof ConfigSchema>;
export interface AppConfig extends FileConfig {
  /** Resolved API key. Never log this. */
  resolvedApiKey: string;
  /** Where the key came from (safe to log). */
  apiKeySource: string;
  /** Absolute course folder, or "" when none is configured. */
  courseFolderAbs: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

const FIELD_HELP: Record<string, string> = {
  "ai.provider": `allowed values: ${PROVIDERS.map((p) => `"${p}"`).join(", ")}`,
  "ai.model": 'a model id for the chosen provider, e.g. "claude-opus-5-5"',
  "ai.apiKeyEnv": 'the NAME of an environment variable holding the key, e.g. "ANTHROPIC_API_KEY"',
  "ai.baseUrl": 'an http(s) URL, or "" to use the provider default',
  "ai.timeoutMs": "integer milliseconds, 1000 to 600000",
  "ai.maxRetries": "integer, 0 to 10",
  "ai.maxOutputTokens": "integer, 256 to 64000",
  "ai.effort": 'one of "low", "medium", "high", "xhigh", "max", or "" to omit (Claude only)',
  courseFolder: 'a folder path, or "" to rely on the model\'s own knowledge',
  topicFolders: 'an object mapping topic name to a subfolder of courseFolder, e.g. { "Calculus 1": "calc1" }',
  "websocket.port": "integer, 1 to 65535",
  logLevel: '"debug", "info", "warn" or "error"',
};

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.join(".") || "(root)";
    const help = FIELD_HELP[field] ?? FIELD_HELP[issue.path.slice(0, 1).join(".")];
    return `  - ${field}: ${issue.message}${help ? `\n      expected: ${help}` : ""}`;
  });
}

/** Validate a parsed config object. Pure: no file access (env is injected). */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv, baseDir: string): AppConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError("config.json is invalid", describeIssues(result.error));
  }
  const cfg = result.data;
  const problems: string[] = [];

  // Key precedence: CENSOR_AI_API_KEY > the variable named by ai.apiKeyEnv > ai.apiKey in the file.
  let resolvedApiKey = "";
  let apiKeySource = "";
  if (env[KEY_OVERRIDE_ENV]?.trim()) {
    resolvedApiKey = env[KEY_OVERRIDE_ENV]!.trim();
    apiKeySource = `environment variable ${KEY_OVERRIDE_ENV}`;
  } else if (cfg.ai.apiKeyEnv && env[cfg.ai.apiKeyEnv]?.trim()) {
    resolvedApiKey = env[cfg.ai.apiKeyEnv]!.trim();
    apiKeySource = `environment variable ${cfg.ai.apiKeyEnv}`;
  } else if (cfg.ai.apiKey && !/PASTE-YOUR-API-KEY/i.test(cfg.ai.apiKey)) {
    resolvedApiKey = cfg.ai.apiKey;
    apiKeySource = "config.json (ai.apiKey)";
  }
  if (!resolvedApiKey && cfg.ai.provider !== "mock") {
    problems.push(
      `  - ai.apiKey: no API key found.\n      Either put the key in "ai.apiKey", or set "ai.apiKeyEnv" to the name of an environment\n      variable that holds it${cfg.ai.apiKeyEnv ? ` (currently "${cfg.ai.apiKeyEnv}", which is not set)` : ""}, or set ${KEY_OVERRIDE_ENV}.`,
    );
  }
  if (cfg.ai.provider === "mock") apiKeySource = "not needed (mock provider)";

  let courseFolderAbs = "";
  if (cfg.courseFolder.trim()) {
    courseFolderAbs = path.resolve(baseDir, cfg.courseFolder.trim());
    if (!existsSync(courseFolderAbs)) {
      problems.push(
        `  - courseFolder: "${courseFolderAbs}" does not exist.\n      Create it, fix the path, or set it to "" to use the model's own knowledge.`,
      );
    }
  }
  for (const [topic, sub] of Object.entries(cfg.topicFolders)) {
    if (path.isAbsolute(sub) || sub.split(/[\\/]/).includes("..")) {
      problems.push(`  - topicFolders["${topic}"]: must be a subfolder name relative to courseFolder, got "${sub}".`);
    }
  }
  if (problems.length) throw new ConfigError("config.json is invalid", problems);
  return { ...cfg, resolvedApiKey, apiKeySource, courseFolderAbs };
}

export type LoadResult = { status: "created"; path: string } | { status: "ok"; config: AppConfig; path: string };

/** Directory of the companion package (where config.json lives). */
export function companionDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Load config.json next to the app. On first run it is created from
 * config.example.json and `{status: "created"}` is returned.
 */
export function loadConfig(configPath?: string, env: NodeJS.ProcessEnv = process.env): LoadResult {
  const dir = companionDir();
  const file = path.resolve(configPath ?? env.CENSOR_CONFIG ?? path.join(dir, "config.json"));
  if (!existsSync(file)) {
    const example = path.join(dir, "config.example.json");
    if (!existsSync(example)) throw new ConfigError(`Neither ${file} nor ${example} exists.`);
    copyFileSync(example, file);
    return { status: "created", path: file };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON`, [
      `  - ${(e as Error).message}`,
      "      Tip: use forward slashes in Windows paths (C:/Users/...) or double the backslashes (C:\\\\Users\\\\...).",
    ]);
  }
  return { status: "ok", config: parseConfig(raw, env, path.dirname(file)), path: file };
}
