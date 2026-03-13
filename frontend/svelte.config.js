import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html'
    }),
    alias: {
      '$lib': 'src/lib',
      '$lib/ui-core': 'src/lib/ui-core',
      '$lib/stores': 'src/lib/stores',
      '$lib/components': 'src/lib/components',
      '$lib/modules': 'src/lib/modules',
      // Legacy aliases (compatibilidad)
      '$ui-core': 'src/lib/ui-core',
      '$modules': 'src/lib/modules'
    }
  }
};

export default config;
