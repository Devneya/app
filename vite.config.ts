/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    if (
      !env.VITE_API_BASE_URL ||
      !env.VITE_GOTRUE_ANON_KEY ||
      (env.VITE_USE_MOCKS === "true" && mode !== "test")
    ) {
      throw new Error(
        "Production requires API and authentication configuration with mocks disabled."
      );
    }
  }

  return {
    plugins: [react()],
    resolve: {
      tsconfigPaths: true,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["src/test/setup.ts"],
      css: true,
      allowOnly: false,
      passWithNoTests: false,
      reporters: ["default", "./src/test/no-skipped-tests-reporter.mjs"],
      include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.test.mjs"],
      exclude: ["tests/e2e/**", "node_modules/**"],
      fileParallelism: false,
    },
  };
});
