import antfu from '@antfu/eslint-config'

export default antfu(
  {
    typescript: true,
    ignores: ['.github', 'dist', 'node_modules', '*.md'],
  },
  {
    rules: {
      'style/brace-style': ['error', '1tbs'],
      'style/arrow-parens': ['error', 'always'],
      'curly': ['error', 'all'],
      'antfu/consistent-list-newline': 'off',
      'style/member-delimiter-style': 'off',
      'style/operator-linebreak': 'off',
      'regexp/no-unused-capturing-group': 'off',
      'no-new': 'off',
    },
  },
  {
    files: ['package.json'],
    rules: {
      'style/eol-last': 'off',
    },
  },
)
