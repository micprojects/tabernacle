import stylistic from '@stylistic/eslint-plugin';
import methodSpacing from './scripts/eslint/method-spacing.js';

// Expression-bodied arrow helpers can stay compact. Functions with a body get
// the same separation whether declared directly, assigned or exported.
const blockFunctionVariable =
  'VariableDeclaration:has(> VariableDeclarator[init.body.type="BlockStatement"])';
const functionStatements = {
  selector: [
    'FunctionDeclaration',
    'ExportNamedDeclaration[declaration.type="FunctionDeclaration"]',
    'ExportDefaultDeclaration[declaration.body.type="BlockStatement"]',
    blockFunctionVariable,
    `ExportNamedDeclaration:has(> ${blockFunctionVariable})`,
  ].join(', '),
};

export default [
  {
    ignores: ['**/node_modules/**', 'dist/**', 'test-results/**', 'output/**', 'firefox/**'],
  },
  {
    files: ['extension/src/**/*.js'],
    rules: {
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-keys': 'error',
      'no-unsafe-optional-chaining': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: {
      '@stylistic': stylistic,
      project: { rules: { 'method-spacing': methodSpacing } },
    },
    // Prettier owns indentation, quotes and wrapping. Only enable complementary
    // spacing rules here, so the two tools never compete over formatting.
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: '*', next: [functionStatements, 'class'] },
        { blankLine: 'always', prev: [functionStatements, 'class'], next: '*' },
      ],
      '@stylistic/lines-between-class-members': ['error', 'always'],
      'project/method-spacing': 'error',
    },
  },
];
