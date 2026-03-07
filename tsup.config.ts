import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  // Keep all node_modules external — don't inline them
  noExternal: [],
  external: [
    'openai',
    '@octokit/rest',
    '@octokit/auth-oauth-device',
    'chalk',
    'commander',
    'conf',
    'globby',
    'ignore',
    'inquirer',
    '@inquirer/prompts',
    'marked',
    'marked-terminal',
    'open',
    'ora',
    'simple-git',
    'zod',
  ],
  splitting: false,
  clean: true,
});
