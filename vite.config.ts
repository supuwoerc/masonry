/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'
import dts from 'vite-plugin-dts'

export default defineConfig({
  base: './',
  build: {
    outDir: './dist',
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format}.js`,
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
  worker: {
    format: 'iife',
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
      },
    },
  },
  plugins: [
    checker({
      enableBuild: true,
      typescript: true,
      eslint: {
        useFlatConfig: true,
        lintCommand: 'eslint .',
      },
    }),
    dts({
      insertTypesEntry: true,
      rollupTypes: true,
    }),
  ],
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    setupFiles: ['./setup-test.ts'],
    globals: true,
  },
  resolve: {
    conditions: ['module', 'browser'],
    alias: {
      '@': `${import.meta.dirname}/src`,
    },
  },
})
