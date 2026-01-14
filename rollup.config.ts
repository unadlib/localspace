import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import pkg from './package.json';

const input = './dist/index.js';

export default {
  input,
  output: [
    {
      format: 'cjs',
      exports: 'named',
      file: 'dist/index.cjs.js',
      sourcemap: true,
    },
    {
      format: 'es',
      file: 'dist/index.esm.js',
      sourcemap: true,
    },
    {
      format: 'umd',
      name: pkg.name
        .split('-')
        .map(([s, ...rest]) => [s.toUpperCase(), ...rest].join(''))
        .join(''),
      file: pkg.unpkg,
      sourcemap: true,
      globals: {
        mutative: 'Mutative',
        zustand: 'Zustand',
        travels: 'Travels',
      },
      exports: 'named',
    },
  ],
  plugins: [
    resolve(),
    commonjs(),
    replace({
      __DEV__: 'false',
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      preventAssignment: true,
    }),
    terser(),
  ],
  external: [],
};
