import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/test/**/*.test.ts", "companion/test/**/*.test.ts", "addon/test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
