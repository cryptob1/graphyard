// Build the same standalone publisher for Actions and the local registry installation proof.
import { build } from 'vite';
import { builtinModules } from 'node:module';
await build({ configFile: false, publicDir: false, logLevel: 'warn', build: {
  target: 'node24', outDir: 'scripts', emptyOutDir: false, minify: false,
  lib: { entry: 'src/publish-verified.ts', formats: ['es'], fileName: () => 'publish-verified.mjs' },
  rollupOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)] },
} });
