import { readFileSync } from 'node:fs';
import { defineConfig, type OutputOptions, type RolldownOptions } from 'rolldown';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { name: string; unpkg: string };

const globalName = pkg.name
  .split('-')
  .map(([s, ...rest]) => [s.toUpperCase(), ...rest].join(''))
  .join('');

const sharedOptions = {
  transform: {
    target: 'es2020',
    define: {
      __DEV__: 'false',
    },
  },
  treeshake: true,
} satisfies Partial<RolldownOptions>;

const universalOptions = {
  ...sharedOptions,
  platform: 'neutral',
  resolve: {
    mainFields: ['module', 'main'],
  },
} satisfies Partial<RolldownOptions>;

const browserOptions = {
  ...sharedOptions,
  platform: 'browser',
} satisfies Partial<RolldownOptions>;

const minifiedOutput = {
  sourcemap: true,
  minify: true,
} satisfies Partial<OutputOptions>;

export default defineConfig([
  {
    ...universalOptions,
    input: './dist/index.js',
    output: [
      {
        ...minifiedOutput,
        format: 'cjs',
        exports: 'named',
        file: 'dist/index.cjs',
      },
      {
        ...minifiedOutput,
        format: 'es',
        file: 'dist/index.esm.js',
      },
    ],
  },
  {
    ...browserOptions,
    input: './dist/index.js',
    output: {
      ...minifiedOutput,
      format: 'umd',
      name: globalName,
      file: pkg.unpkg,
      exports: 'named',
    },
  },
  {
    ...universalOptions,
    input: './dist/react-native.js',
    output: [
      {
        ...minifiedOutput,
        format: 'cjs',
        exports: 'named',
        file: 'dist/react-native.cjs',
      },
      {
        ...minifiedOutput,
        format: 'es',
        file: 'dist/react-native.esm.js',
      },
    ],
  },
]);
