// ESLint flat config — the repository had no lint configuration before the
// product-form mandate, whose §12 requires "typecheck و lint و unit tests و
// build ... بلا أخطاء". This is a real configuration, not a stub: it type-less
// lints both the React frontend and the Worker, and CI fails on any error.
//
// Rules are chosen to catch actual defects (unused bindings, unreachable code,
// accidental globals, `==` against null, fallthrough) rather than to enforce a
// formatting opinion, so it can run on the existing codebase without a
// mass-rewrite commit that would bury the mandate's real changes.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'studio/**',
      'node_modules/**',
      // `**/` because every Worker keeps its own build scratch: the root's,
      // and one per `services/*/wrangler.jsonc` the local dev rig bundles.
      '**/.wrangler/**',
      'coverage/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // TypeScript already reports undefined identifiers, with the ambient
      // Workers/DOM types in scope. ESLint's own no-undef only sees the
      // globals list and produces false positives on D1Database, R2Bucket and
      // friends, so it is off for TS — this is the documented guidance.
      'no-undef': 'off',
      // An unused binding is nearly always a leftover from an edit. `_`-prefixed
      // names and rest-siblings are the deliberate "I know, ignore it" escape
      // hatch used by the cost-stripping code.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `any` is used deliberately in a few D1/JSON boundaries; flag it so it
      // stays visible without failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-fallthrough': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Node scripts and tests. The verification scripts drive a real browser
    // through Playwright, so callbacks handed to page.evaluate() reference
    // window/document from inside a Node file — both global sets belong here.
    // `services/*/dev/**` holds the local rigs' probe scripts — Node files by
    // the same reasoning as scripts/.
    files: ['scripts/**/*.{js,mjs}', 'tests/**/*.ts', 'services/*/dev/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  }
);
