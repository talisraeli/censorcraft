import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { Logger } from "./logger";

async function main(): Promise<void> {
  const log = new Logger("info");
  const configArg = process.argv.indexOf("--config");
  const configPath = configArg > 0 ? process.argv[configArg + 1] : undefined;

  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}:\n${error.problems.join("\n")}\n\nFix the file and start the companion again.\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (loaded.status === "created") {
    console.log(
      [
        "",
        "Welcome to the CensorCraft companion!",
        "",
        `A new config file was created at:\n  ${loaded.path}`,
        "",
        "Open it in a text editor and fill in:",
        '  - ai.provider   "claude", "gemini" or "openai"',
        "  - ai.model      the model to use",
        "  - ai.apiKey     your API key (or ai.apiKeyEnv: the name of an environment variable that holds it)",
        "  - courseFolder  the folder with your course material",
        "",
        "The key is stored in plain text in that file. It is git-ignored; do not share it.",
        "Then run `pnpm start` again.",
        "",
      ].join("\n"),
    );
    return;
  }

  const config = loaded.config;
  log.setLevel(config.logLevel);
  log.addSecret(config.resolvedApiKey);
  log.info(`Config: ${loaded.path}`);
  log.info(`AI: ${config.ai.provider} / ${config.ai.model} (API key: ${config.apiKeySource})`);

  let app;
  try {
    app = await createApp(config, log);
  } catch (error) {
    log.error((error as Error).message);
    process.exitCode = 1;
    return;
  }

  if (app.index.enabled) {
    const s = app.index.stats;
    log.info(`Course folder: ${config.courseFolderAbs} - ${s.files} file(s), ${s.chunks} chunk(s)`);
    if (s.folders.length) log.info(`Topic subfolders found: ${s.folders.join(", ")}`);
    if (s.files === 0) log.warn("No readable course files found; questions will come from the model's own knowledge.");
  } else {
    log.info("No courseFolder configured; questions will come from the model's own knowledge.");
  }

  const port = config.websocket.port;
  log.info(`Listening. In Minecraft (cheats on, 'Require Encrypted WebSockets' off) type:  /connect ws://localhost:${port}`);
  log.info("Press Ctrl+C to stop.");

  const shutdown = () => {
    log.info("Shutting down...");
    app.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  // Last resort. Never print raw error objects that could embed request headers.
  console.error(`Fatal: ${(error as Error)?.message ?? String(error)}`);
  process.exitCode = 1;
});
