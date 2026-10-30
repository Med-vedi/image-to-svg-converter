import { defineConfig } from 'vite'

// Applied to the built page only: Vite's dev server needs inline scripts for HMR.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export default defineConfig({
  base: './',
  build: { target: 'es2022', modulePreload: { polyfill: false } },
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts'] },
  plugins: [
    {
      name: 'inject-csp',
      apply: 'build',
      transformIndexHtml: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
  ],
} as import('vite').UserConfig)
