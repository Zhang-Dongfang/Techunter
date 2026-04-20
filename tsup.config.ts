import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp.ts'],
  format: ['esm'],
  dts: false,
  // Bundle all npm packages into the output — users install zero extra deps
  noExternal: [/.*/],
  splitting: false,
  clean: true,
});
