/// <reference types="vitest" />
import path from 'node:path'
import { defineConfig } from 'vite'
import packageJson from './package.json'

function getPackageNameCamelCase() {
  const raw = packageJson.name || ''
  const withoutScope = raw.replace(/^@.*\//, '')
  const parts = withoutScope.split(/[^a-z0-9]+/i).filter(Boolean)
  return parts[0] ?? 'lib'
}

const fileName = {
  es: `${getPackageNameCamelCase()}.esm.js`,
  cjs: `${getPackageNameCamelCase()}.cjs`,
  iife: `${getPackageNameCamelCase()}.iife.js`,
}

const formats = Object.keys(fileName) as Array<keyof typeof fileName>

export default defineConfig({
  base: './',
  build: {
    outDir: './dist',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: getPackageNameCamelCase(),
      formats,
      fileName: (format) => fileName[format],
    },
    minify: 'terser',
    terserOptions: {
      keep_classnames: true,
      keep_fnames: true,
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
    },
    setupFiles: ['./setup-test.ts'],
    globals: true,
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
