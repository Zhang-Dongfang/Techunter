import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
});
