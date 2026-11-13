import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// base "./": the built site works from any sub-path (GitHub Pages serves /<repo>/).
export default defineConfig({
  base: "./",
  plugins: [react()],
  test: { environment: "node", include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
});
