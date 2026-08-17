import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/server/index.ts'],
    outDir: 'dist/server',
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    splitting: false,
    sourcemap: true,
    clean: true,
    outExtension: () => ({ js: '.mjs' }),
  },
  {
    entry: {
      main: 'src/desktop/main.ts',
      preload: 'src/desktop/preload.ts',
    },
    outDir: 'dist/desktop',
    format: ['cjs'],
    platform: 'node',
    target: 'node24',
    splitting: false,
    sourcemap: true,
    clean: false,
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
