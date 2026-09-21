// ESLint flat config.
//   - Root: Node ESM (server, lib, scripts, tests) + a CommonJS island for electron/.
//   - client/src: browser + React (hooks rules are errors — a missing dep in
//     useEffect is a real bug in this app, not a style nit).
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      'client/node_modules/**',
      'client/dist/**',
      'release/**',
      'bin/**',
      'coverage/**',
      'website/**',
      'docs/**',
      'build/**',
    ],
  },

  // ---- Node (ESM) --------------------------------------------------------
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['client/**', 'electron/**'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  // ---- Electron main process (CommonJS) ----------------------------------
  {
    files: ['electron/**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ---- Client (browser + React) ------------------------------------------
  {
    files: ['client/src/**/*.{js,jsx}', 'client/vite.config.js'],
    ...js.configs.recommended,
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2024, ...globals.node, __APP_VERSION__: 'readonly' },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  // ---- theme-init.js: tiny pre-paint script; `var` is deliberate there ----
  {
    files: ['client/src/theme-init.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-var': 'off' },
  },
];
