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
    // The preload bridge is reachable ONLY through src/api. Everything else
    // calls api.* so the facade stays the single inventory (api/apiSurface.test.js
    // pins it to preload and the web bridge); a component reaching for
    // window.mediaWorkspace directly is how four preload methods went missing
    // from the facade unnoticed.
    files: ["src/**/*.{js,jsx}"],
    ignores: ["src/api/**", "src/web-main.jsx"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: 'MemberExpression[object.name="window"][property.name="mediaWorkspace"]',
        message: "Use api.* (src/api) instead of window.mediaWorkspace — see api/client.js.",
      }],
    },
  },
  {
    // Node ESM dev scripts.
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: sharedRules,
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
