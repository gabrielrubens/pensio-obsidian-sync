// Flat config (ESLint v9+). Replaces the legacy .eslintrc, which ESLint 9/10
// could not load. Uses eslint-plugin-obsidianmd (the same ruleset the Community
// Plugins review bot runs) plus typescript-eslint's type-checked rules so the
// no-unsafe-* / no-explicit-any warnings surface here, not just in review.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
    {
        ignores: [
            "main.js",
            "node_modules/**",
            "**/__tests__/**",
            "**/__mocks__/**",
            "*.config.mjs",
            "*.mjs",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...obsidianmd.configs.recommended,
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            // Obsidian plugins run in a browser-like (Electron/WebView) context.
            globals: { ...globals.browser, NodeJS: "readonly" },
        },
        rules: {
            // TypeScript's own checker handles undefined identifiers; the
            // core no-undef rule only produces false positives on TS globals
            // (per typescript-eslint guidance).
            "no-undef": "off",
            // Callback args are intentionally kept for signature clarity.
            "@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
            "@typescript-eslint/ban-ts-comment": "off",

            // --- On, and they matter -------------------------------------------
            // `@typescript-eslint/no-deprecated` and
            // `obsidianmd/settings-tab/prefer-setting-definitions` (both in
            // the configs above) were switched off while `minAppVersion` was
            // 1.11.4, where the declarative settings API did not exist. Plugin
            // 0.6.1 moved to it and to 1.13.0, and the Community plugin review
            // had reported exactly these: `display()`, `setWarning()`, and a
            // tab missing from Obsidian's settings search. Keep them on.

            // --- Deliberately off (documented) ---------------------------------
            // The sentence-case rule can't distinguish our proper nouns/acronyms
            // (Pensio, AI, Pensio Journaling Sync) and would wrongly lowercase
            // the brand — the review tooling doesn't enforce it. Casing is
            // reviewed by hand instead.
            "obsidianmd/ui/sentence-case": "off",
        },
    },
);
