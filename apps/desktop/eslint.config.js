const js = require("@eslint/js");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");

const sharedRules = {
  ...js.configs.recommended.rules,
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
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
