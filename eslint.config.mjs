import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".openai/**",
    ".npm-cache/**",
    ".test-build/**",
    "CODIO-Portable-*/**",
    "desktop-dist*/**",
    "desktop-package-stage/**",
    "installer-cache/**",
    "voice-engine/models/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
