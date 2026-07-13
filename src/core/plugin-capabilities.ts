import type { LocalSpacePlugin } from '../types.js';

export type BuiltInStorageTransformKind = 'encryption' | 'compression' | 'ttl';

const STORAGE_TRANSFORM_KIND = Symbol.for(
  'localspace.internal.storage-transform-kind'
);
const STORAGE_TRANSFORM_KINDS = new Set<BuiltInStorageTransformKind>([
  'encryption',
  'compression',
  'ttl',
]);

type MarkedPlugin = LocalSpacePlugin & {
  [STORAGE_TRANSFORM_KIND]?: BuiltInStorageTransformKind;
};

export const markBuiltInStorageTransformPlugin = <T extends LocalSpacePlugin>(
  plugin: T,
  kind: BuiltInStorageTransformKind
): T => {
  Object.defineProperty(plugin, STORAGE_TRANSFORM_KIND, {
    value: kind,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return plugin;
};

export const getBuiltInStorageTransformKind = (
  plugin: LocalSpacePlugin
): BuiltInStorageTransformKind | null => {
  const kind = (plugin as MarkedPlugin)[STORAGE_TRANSFORM_KIND];
  return kind && STORAGE_TRANSFORM_KINDS.has(kind) ? kind : null;
};
