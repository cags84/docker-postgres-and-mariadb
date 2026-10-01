import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.{js,ts,tsx}'], languageOptions: { globals: {...globals.node, ...globals.browser} } },
);
