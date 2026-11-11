import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc also emits test files into dist; never discover those copies after a build.
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
    // Route fixtures explicitly exercise optional bearer authentication. Keep
    // this independent of the operator's .env; the application default is false.
    env: { AUTH_ALLOW_BEARER_TOKENS: "true", DATA_IMPORT_MAX: "100", DATA_EXPORT_MAX: "100" }
  }
});
