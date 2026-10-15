const js = require("@eslint/js");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");

// Components take their layer from the ladder in src/ui/zIndex.js
// (style={{ zIndex: Z.x }}), never from a Tailwind `z-[…]` literal: 28 of
// those, with 17 different numbers, once sat beside a ladder only ui/Modal
// read. Flags the literal in a string or a template.
const noZIndexLiteral = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const message = "Use the Z ladder (src/ui/zIndex.js) as style={{ zIndex: Z.x }} instead of a z-[…] class.";
    return {
      Literal(node) {
        if (typeof node.value === "string" && node.value.includes("z-[")) context.report({ node, message });
      },
      TemplateElement(node) {
        if (node.value.raw.includes("z-[")) context.report({ node, message });
      },
    };
  },
};

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
    files: ["src/**/*.{js,jsx}"],
    plugins: { afterframe: { rules: { "no-z-index-literal": noZIndexLiteral } } },
    rules: { "afterframe/no-z-index-literal": "error" },
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
      "*.cjs",
      "scripts/**/*.cjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: sharedRules,
  },
];
