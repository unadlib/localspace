import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import pkg from './package.json';

const basePlugins = [
  resolve(),
  commonjs(),
  replace({
    __DEV__: 'false',
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production'
    ),
    preventAssignment: true,
  }),
  terser(),
];

const indexBundle = {
  input: './dist/index.js',
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
  plugins: basePlugins,
  external: [],
};

const reactNativeBundle = {
  input: './dist/react-native.js',
  output: [
    {
      format: 'cjs',
      exports: 'named',
      file: 'dist/react-native.cjs.js',
      sourcemap: true,
    },
    {
      format: 'es',
      file: 'dist/react-native.esm.js',
      sourcemap: true,
    },
  ],
  plugins: basePlugins,
  external: [],
};

export default [indexBundle, reactNativeBundle];
