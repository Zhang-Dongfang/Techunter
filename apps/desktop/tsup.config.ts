import { defineConfig } from 'tsup';

export default defineConfig([
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
    noExternal: ['@techunter/core'],
    sourcemap: true,
    clean: true,
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
