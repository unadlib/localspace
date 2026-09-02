import type { LocalSpacePlugin, PluginContext } from '../types.js';

export type BuiltInStorageTransformKind = 'encryption' | 'compression' | 'ttl';

const STORAGE_TRANSFORM_KIND = Symbol.for(
  'localspace.internal.storage-transform-kind'
);
const BACKGROUND_TASK_CONTROLLER = Symbol.for(
  'localspace.internal.background-task-controller'
);
export const TTL_BACKGROUND_CLEANUP_OPERATION = Symbol.for(
  'localspace.internal.ttl-background-cleanup'
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

type PluginContextInternalState = {
  operation?: PluginInternalOperation;
  hiddenKeys?: Set<string>;
};

const pluginContextInternalStates = new WeakMap<
  PluginContext,
  PluginContextInternalState
>();

const getPluginContextInternalState = (
  context: PluginContext
): PluginContextInternalState => {
  const existing = pluginContextInternalStates.get(context);
  if (existing) {
    return existing;
  }
  const created: PluginContextInternalState = {};
  pluginContextInternalStates.set(context, created);
  return created;
};

export const sharePluginContextInternalState = (
  source: PluginContext,
  target: PluginContext
): void => {
  pluginContextInternalStates.set(
    target,
    getPluginContextInternalState(source)
  );
};

export type PluginInternalOperation = typeof TTL_BACKGROUND_CLEANUP_OPERATION;

export const markPluginInternalOperation = (
  context: PluginContext,
  operation: PluginInternalOperation | undefined
): void => {
  if (!operation) {
    return;
  }
  getPluginContextInternalState(context).operation = operation;
};

export const hasPluginInternalOperation = (
  context: PluginContext,
  operation: PluginInternalOperation
): boolean =>
  getPluginContextInternalState(context).operation === operation;

export const markPluginValueHidden = (
  context: PluginContext,
  key: string
): void => {
  const state = getPluginContextInternalState(context);
  const hiddenKeys = state.hiddenKeys ?? new Set<string>();
  hiddenKeys.add(key);
  state.hiddenKeys = hiddenKeys;
};

export const isPluginValueHidden = (
  context: PluginContext,
  key: string
): boolean =>
  getPluginContextInternalState(context).hiddenKeys?.has(key) ?? false;

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
