import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Erosion gate: the suite currently sits at ~87% lines / ~81%
      // branches / ~95% functions. Thresholds sit just below that so any
      // PR that drops meaningful coverage fails loudly instead of
      // silently thinning the redaction/trust-boundary tests.
      thresholds: {
        lines: 85,
        branches: 78,
        functions: 90,
        statements: 85,
      },
    },
  },
});
