import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  define: {
    __TECHUNTER_VERSION__: JSON.stringify(version),
  },
  dts: false,
  // Bundle all npm packages into the output — users install zero extra deps
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  outExtension() {
    return {
      js: '.cjs',
    };
  },
});
