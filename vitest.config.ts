import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // each test file gets its own process: the HTTP audit trail and key redaction set are process-wide
    pool: "forks",
    testTimeout: 30000,
  },
});
