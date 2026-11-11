import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlyphData } from "@censorcraft/shared";
import { createProvider } from "./ai/factory";
import type { AiProvider } from "./ai/provider";
import { AppConfig, companionDir } from "./config";
import { Engine } from "./engine";
import { CourseIndex } from "./ingest/index";
import { Limiter } from "./limits";
import { Logger } from "./logger";
import { MathSanitizer } from "./math/sanitize";
import { Prompts } from "./prompts";
import { CompanionServer } from "./server";
import { SessionStore } from "./sessions";

export interface App {
  server: CompanionServer;
  index: CourseIndex;
  engine: Engine;
  provider: AiProvider;
  close(): Promise<void>;
}

/** The glyph allowlist is read from disk at start so edits apply without rebuilding anything. */
export function loadGlyphs(): GlyphData {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../shared/glyphs.json");
  return JSON.parse(readFileSync(file, "utf8")) as GlyphData;
}

export interface CreateAppOptions {
  provider?: AiProvider;
  pingIntervalMs?: number;
  watch?: boolean;
}

/** Wire everything together and start listening. Used by the CLI entry point and by tests. */
export async function createApp(config: AppConfig, log: Logger, options: CreateAppOptions = {}): Promise<App> {
  const glyphs = loadGlyphs();
  const sanitizer = new MathSanitizer(glyphs);
  const prompts = Prompts.load(companionDir(), glyphs);
  const provider = options.provider ?? createProvider(config);
  const limiter = new Limiter(config.limits);
  const index = new CourseIndex({
    root: config.courseFolderAbs,
    topicFolders: config.topicFolders,
    maxChunkChars: config.limits.maxMaterialChars,
    log,
  });
  if (index.enabled) {
    await index.scan();
    if (options.watch !== false) await index.watch();
  }
  const engine = new Engine({
    provider,
    index,
    sanitizer,
    limiter,
    prompts,
    log,
    maxOutputTokens: config.ai.maxOutputTokens,
    maxRetries: config.ai.maxRetries,
  });
  const sessions = new SessionStore(config.session.idleTimeoutMinutes * 60_000);
  const server = new CompanionServer({
    host: config.websocket.host,
    port: config.websocket.port,
    engine,
    sessions,
    log,
    pingIntervalMs: options.pingIntervalMs,
  });
  await server.listen();
  return {
    server,
    index,
    engine,
    provider,
    async close() {
      await server.close();
      await index.close();
    },
  };
}
