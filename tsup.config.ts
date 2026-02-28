import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Keep all node_modules external — don't inline them
  noExternal: [],
  external: [
    'openai',
    '@octokit/rest',
    'chalk',
    'commander',
    'conf',
    'globby',
    'ignore',
    'inquirer',
    '@inquirer/prompts',
    'ora',
    'simple-git',
    'zod',
  ],
  splitting: false,
  clean: true,
});
