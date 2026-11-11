import type { AppConfig } from "../config";
import { ClaudeProvider } from "./claude";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import { OpenAiProvider } from "./openai";
import type { AiProvider } from "./provider";

export function createProvider(config: AppConfig): AiProvider {
  const { ai } = config;
  const common = { apiKey: config.resolvedApiKey, model: ai.model, baseUrl: ai.baseUrl, timeoutMs: ai.timeoutMs };
  switch (ai.provider) {
    case "claude":
      return new ClaudeProvider({ ...common, effort: ai.effort });
    case "gemini":
      return new GeminiProvider(common);
    case "openai":
      return new OpenAiProvider(common);
    case "mock":
      return new MockProvider(ai.model.startsWith("mock") ? ai.model : "mock");
  }
}
