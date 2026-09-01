import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "audit/**/*.ts",
      "tests/**/*.ts",
      "scripts/build-report.ts",
      "scripts/check-env.ts",
      "scripts/discover-companies.ts",
      "scripts/fetch-filings.ts",
      "scripts/seed-fde-signals.ts",
    ],
    // These files were migrated from JavaScript and intentionally sit behind
    // tsconfig.tools.json's compatibility boundary. Runtime payloads and
    // compiled CommonJS fixtures are dynamic, so explicit any is preferable
    // to pretending their untyped wire shape is known.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled test artefacts — not project source.
    ".test-build/**",
    // Compiled report-builder artefacts — same reason.
    ".report-build/**",
  ]),
]);

export default eslintConfig;
