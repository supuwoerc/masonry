/// <reference types="vitest" />
import path from 'node:path'
import { defineConfig } from 'vite'
import packageJson from './package.json'

function getPackageName() {
  return packageJson.name
}

function getPackageNameCamelCase() {
  return getPackageName().replace(/-./g, (char) => char[1].toUpperCase())
}

const fileName = {
  es: `${getPackageName()}.esm.js`,
  cjs: `${getPackageName()}.cjs`,
  iife: `${getPackageName()}.iife.js`,
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
