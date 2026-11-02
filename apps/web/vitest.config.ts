import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Unit-test config for the pure modules (money, authz, jwt, landing). jsdom so
// @testing-library/react can mount if a test needs it; the `@` alias mirrors
// tsconfig `paths` so `@/...` imports resolve the same way they do under tsc.
// Excluded from the Next build's type-check (tsconfig `exclude`) because the
// workspace carries two Vite installs whose Plugin types are nominally distinct.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
