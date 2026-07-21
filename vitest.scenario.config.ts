import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [{
    name: 'resolve-ts-from-js',
    resolveId(source, importer) {
      if (source.endsWith('.js') && importer && !source.includes('node_modules')) {
        return this.resolve(source.replace(/\.js$/, '.ts'), importer, { skipSelf: true });
      }
    },
  }],
  test: {
    include: ['tests/scenario/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
