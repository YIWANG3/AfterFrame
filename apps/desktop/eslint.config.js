const js = require("@eslint/js");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");

const sharedRules = {
  ...js.configs.recommended.rules,
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    // `const { drop, ...rest } = obj` is how you omit a key; the named binding
    // is the point, not an oversight.
    ignoreRestSiblings: true,
  }],
  "no-useless-assignment": "error",
  "no-empty": ["error", { allowEmptyCatch: true }],
};

module.exports = [
  {
    ignores: [
      "dist/**",
      "release/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "e2e/.artifacts/**",
      "native/bin/**",
    ],
  },
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...sharedRules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Cross-process pure modules: ESM for Vite, require(esm)'d by main.
    files: ["shared/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: sharedRules,
  },
  {
    files: [
      "electron/**/*.js",
      "*.config.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: sharedRules,
  },
];
