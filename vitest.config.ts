import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(process.cwd()) },
  },
  test: {
    environment: "node",
    // lib/mongodb reads MONGODB_URI/JWT_SECRET at module scope; unit tests
    // never connect, the integration suite overrides these before importing.
    env: {
      MONGODB_URI: "mongodb://127.0.0.1:27017/hpb-unit-test",
      MONGODB_DB: "hpb-unit-test",
      JWT_SECRET: "unit-test-secret-0123456789abcdef0123456789abcdef",
    },
    include: ["tests/**/*.test.ts"],
    // Integration tests spin up an in-memory MongoDB (mongodb-memory-server);
    // the first run downloads a mongod binary, so allow extra time.
    testTimeout: 120_000,
  },
});
