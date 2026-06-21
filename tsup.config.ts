import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // `dependencies` and `peerDependencies` (opengradient-sdk, @ai-sdk/provider,
  // ai) are externalized by tsup automatically — never bundled.
});
