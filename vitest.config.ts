import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [
    {
      name: 'resolve-ts-from-js',
      resolveId(source, importer) {
        if (source.endsWith('.js') && importer && !source.includes('node_modules')) {
          return this.resolve(source.replace(/\.js$/, '.ts'), importer, { skipSelf: true });
        }
      },
    },
  ],
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      '../samata-plugins/*/tests/**/*.test.ts'
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
  },
});
