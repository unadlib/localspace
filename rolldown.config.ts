import { readFileSync } from 'node:fs';
import { defineConfig, type OutputOptions, type RolldownOptions } from 'rolldown';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { name: string; unpkg: string };

const globalName = pkg.name
  .split('-')
  .map(([s, ...rest]) => [s.toUpperCase(), ...rest].join(''))
  .join('');

const environment = process.env.NODE_ENV || 'production';

const sharedOptions = {
  platform: 'browser',
  transform: {
    target: 'es2020',
    define: {
      __DEV__: 'false',
      'process.env.NODE_ENV': JSON.stringify(environment),
    },
  },
  treeshake: true,
} satisfies Partial<RolldownOptions>;

const minifiedOutput = {
  sourcemap: true,
  minify: true,
} satisfies Partial<OutputOptions>;

export default defineConfig([
  {
    ...sharedOptions,
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
      {
        ...minifiedOutput,
        format: 'umd',
        name: globalName,
        file: pkg.unpkg,
        globals: {
          mutative: 'Mutative',
          zustand: 'Zustand',
          travels: 'Travels',
        },
        exports: 'named',
      },
    ],
  },
  {
    ...sharedOptions,
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
