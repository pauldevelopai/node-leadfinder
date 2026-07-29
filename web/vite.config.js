import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Build the LeadFinder surface into ../public (what the runtime serves).
// base:'./' → all asset + entry URLs are RELATIVE, so the page works both at '/'
// (local) and under '/nodes/leadfinder/app/' (hosted) — the #1 hosted-Node rule.
export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: {
    outDir: join(here, '..', 'public'),
    emptyOutDir: true,
  },
});
