/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  server: {
    port: 5173,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    css: true,
    exclude: ["tests/e2e/**", "node_modules/**"],
    fileParallelism: false,
  },
});
