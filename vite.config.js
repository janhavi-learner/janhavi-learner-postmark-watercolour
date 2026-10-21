import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:single` bundles everything (paper included) into one HTML file
// so it can be shared as a single page for phone testing.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: mode === 'single' ? { assetsInlineLimit: Infinity, outDir: 'dist-single' } : {},
}));
