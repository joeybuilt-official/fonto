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
    "next-env.d.ts",
    // Gitignored local git worktrees (`.claude/worktrees/*`) hold other
    // branches' checkouts — never lint those stale copies as if they were
    // this tree's source. They are absent on a clean clone / CI.
    ".claude/**",
  ]),
]);

export default eslintConfig;
