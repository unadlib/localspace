import type { LocalSpacePlugin, PluginContext } from '../types.js';

export type BuiltInStorageTransformKind = 'encryption' | 'compression' | 'ttl';

const STORAGE_TRANSFORM_KIND = Symbol.for(
  'localspace.internal.storage-transform-kind'
);
const BACKGROUND_TASK_CONTROLLER = Symbol.for(
  'localspace.internal.background-task-controller'
);
const STORAGE_TRANSFORM_KINDS = new Set<BuiltInStorageTransformKind>([
  'encryption',
  'compression',
  'ttl',
]);

type MarkedPlugin = LocalSpacePlugin & {
  [STORAGE_TRANSFORM_KIND]?: BuiltInStorageTransformKind;
  [BACKGROUND_TASK_CONTROLLER]?: PluginBackgroundTaskController;
};

export type PluginBackgroundTaskPause = {
  pending: boolean;
  settled: Promise<void>;
  resume(): void;
};

type PluginBackgroundTaskController = (
  context: PluginContext
) => PluginBackgroundTaskPause;

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

export const markPluginBackgroundTaskController = <T extends LocalSpacePlugin>(
  plugin: T,
  controller: PluginBackgroundTaskController
): T => {
  Object.defineProperty(plugin, BACKGROUND_TASK_CONTROLLER, {
    value: controller,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return plugin;
};

export const getPluginBackgroundTaskController = (
  plugin: LocalSpacePlugin
): PluginBackgroundTaskController | null =>
  (plugin as MarkedPlugin)[BACKGROUND_TASK_CONTROLLER] ?? null;
