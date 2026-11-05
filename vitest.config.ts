import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc also emits test files into dist; never discover those copies after a build.
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"]
  }
});
