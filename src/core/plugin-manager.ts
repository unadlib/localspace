import type {
  BatchItems,
  BatchResponse,
  DbInfo,
  LocalSpaceConfig,
  LocalSpaceInstance,
  LocalSpacePlugin,
  PluginContext,
  PluginErrorInfo,
  PluginOperation,
  PluginStage,
} from '../types.js';
import { createLocalSpaceError, LocalSpaceError } from '../errors.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
import { warnDeprecation } from '../utils/deprecations.js';
import {
  getBuiltInStorageTransformKind,
  getPluginBackgroundTaskController,
  type BuiltInStorageTransformKind,
  type PluginBackgroundTaskPause,
} from './plugin-capabilities.js';

export class PluginAbortError extends Error {
  constructor(message = 'Plugin aborted the operation') {
    super(message);
    this.name = 'PluginAbortError';
  }
}

type PluginHost = LocalSpaceInstance & {
  _config: LocalSpaceConfig;
  _dbInfo: DbInfo | null;
};

type PluginLifecycleInvocation = {
  instance: LocalSpaceInstance;
  invoke<T>(callback: () => T): Promise<Awaited<T>>;
};

type PluginLifecycleBridge = {
  createInvocation(
    lifecycle: 'plugin-init' | 'plugin-destroy'
  ): PluginLifecycleInvocation;
};

type RegisteredPlugin = {
  plugin: LocalSpacePlugin;
  order: number;
};

type BatchLineageEntry<T> = {
  key: string;
  physicalValue: T;
  logicalValue: T;
};

type PreparedSetItems<T> = {
  entries: BatchItems<T>;
  logicalEntries: Array<{ key: string; value: T }>;
  hasStorageTransforms: boolean;
};

const createBatchLineage = <T>(
  entries: BatchItems<T>
): BatchLineageEntry<T>[] =>
  normalizeBatchEntries(entries).map(({ key, value }) => ({
    key,
    physicalValue: value,
    logicalValue: value,
  }));

const updateBatchLineage = <T>(
  previous: BatchLineageEntry<T>[],
  entries: BatchItems<T>,
  preserveLogicalValues: boolean
): BatchLineageEntry<T>[] => {
  const previousByKey = new Map<string, BatchLineageEntry<T>[]>();
  for (const entry of previous) {
    const matches = previousByKey.get(entry.key) ?? [];
    matches.push(entry);
    previousByKey.set(entry.key, matches);
  }

  return normalizeBatchEntries(entries).map(({ key, value }) => {
    const matches = previousByKey.get(key);
    const previousEntry = matches?.shift();
    // Built-in transforms only change the physical representation. Custom
    // hooks retain lineage for pass-through entries, while a replacement or
    // newly introduced key establishes its own logical value.
    const logicalValue =
      previousEntry &&
      (preserveLogicalValues || Object.is(value, previousEntry.physicalValue))
        ? previousEntry.logicalValue
        : value;

    return { key, physicalValue: value, logicalValue };
  });
};

const sharedMetadataFor = (): Record<string, unknown> => Object.create(null);
const COMBINED_PLUGIN_HOOK_PAIRS: Array<
  [keyof LocalSpacePlugin, keyof LocalSpacePlugin]
> = [
  ['beforeSetItems', 'beforeSet'],
  ['afterSetItems', 'afterSet'],
  ['beforeGetItems', 'beforeGet'],
  ['afterGetItems', 'afterGet'],
  ['beforeRemoveItems', 'beforeRemove'],
  ['afterRemoveItems', 'afterRemove'],
];

/**
 * Plugin combination warnings to help users avoid problematic configurations.
 */
const PLUGIN_WARNINGS = {
  LENIENT_WITH_COMPRESSION: {
    condition: (
      plugins: LocalSpacePlugin[],
      config: PluginHost['_config']
    ): boolean => {
      const hasCompression = plugins.some(
        (plugin) => getBuiltInStorageTransformKind(plugin) === 'compression'
      );
      return hasCompression && config.pluginErrorPolicy === 'lenient';
    },
    message:
      '[localspace] Warning: Using lenient error policy with compression plugin may cause data corruption if decompression fails.',
  },
  ENCRYPTION_BEFORE_COMPRESSION: {
    condition: (plugins: LocalSpacePlugin[]): boolean => {
      const encIdx = plugins.findIndex(
        (plugin) => getBuiltInStorageTransformKind(plugin) === 'encryption'
      );
      const compIdx = plugins.findIndex(
        (plugin) => getBuiltInStorageTransformKind(plugin) === 'compression'
      );
      if (encIdx === -1 || compIdx === -1) return false;
      // Check priority - encryption should have lower priority than compression
      // to run after compression in beforeSet
      const encPriority = plugins[encIdx]?.priority ?? 0;
      const compPriority = plugins[compIdx]?.priority ?? 0;
      // Also check registration order when priorities are equal
      // (plugins with same priority are sorted by registration order, earlier = higher precedence)
      return (
        encPriority > compPriority ||
        (encPriority === compPriority && encIdx < compIdx)
      );
    },
    message:
      '[localspace] Warning: Encryption plugin runs before compression (either due to higher priority or earlier registration order). This means data will be encrypted before compression, which reduces compression effectiveness. Consider adjusting priorities (compression should have higher priority than encryption) or registration order.',
  },
} as const;

export class PluginManager {
  private readonly host: PluginHost;

  private readonly lifecycleBridge: PluginLifecycleBridge;

  private readonly sharedMetadata: Record<string, unknown> =
    sharedMetadataFor();

  private readonly pluginRegistry: RegisteredPlugin[] = [];

  private readonly initialized = new WeakSet<LocalSpacePlugin>();

  private readonly initPromises = new WeakMap<
    LocalSpacePlugin,
    Promise<void>
  >();

  private readonly initializationPasses = new Set<Promise<void>>();

  private readonly destroyed = new WeakSet<LocalSpacePlugin>();

  private readonly destroyPromises = new WeakMap<
    LocalSpacePlugin,
    Promise<void>
  >();

  private readonly disabled = new WeakSet<LocalSpacePlugin>();

  private orderCounter = 0;

  private warningsEmitted = new Set<string>();

  constructor(
    host: PluginHost,
    initialPlugins: LocalSpacePlugin[],
    lifecycleBridge: PluginLifecycleBridge
  ) {
    this.host = host;
    this.lifecycleBridge = lifecycleBridge;
    if (initialPlugins.length) {
      this.registerPlugins(initialPlugins);
    }
  }

  /**
   * Validate plugin combinations and emit warnings for potential issues.
   */
  private validatePluginCombinations(): void {
    const plugins = this.pluginRegistry.map((r) => r.plugin);
    const config = this.host._config;

    for (const [key, warning] of Object.entries(PLUGIN_WARNINGS)) {
      if (this.warningsEmitted.has(key)) continue;
      if (warning.condition(plugins, config)) {
        console.warn(warning.message);
        this.warningsEmitted.add(key);
      }
    }
  }

  hasPlugins(): boolean {
    return this.pluginRegistry.length > 0;
  }

  assertNoStorageTransformBypass(
    operation: 'iterate' | 'runTransaction'
  ): void {
    const pluginNames = [
      ...new Set(
        this.getActivePlugins()
          .map((plugin) => getBuiltInStorageTransformKind(plugin))
          .filter((kind): kind is BuiltInStorageTransformKind => kind !== null)
      ),
    ];

    if (pluginNames.length === 0) {
      return;
    }

    throw createLocalSpaceError(
      'UNSUPPORTED_OPERATION',
      `${operation} cannot bypass active storage transformation plugins.`,
      {
        operation,
        plugins: pluginNames,
        reason: 'storage-transform-plugin-bypass',
      }
    );
  }

  registerPlugins(plugins: LocalSpacePlugin[]): void {
    for (const plugin of plugins) {
      if (!plugin) continue;
      if (
        getBuiltInStorageTransformKind(plugin) === null &&
        COMBINED_PLUGIN_HOOK_PAIRS.some(
          ([batchHook, singleHook]) =>
            typeof plugin[batchHook] === 'function' &&
            typeof plugin[singleHook] === 'function'
        )
      ) {
        warnDeprecation(
          'combined-plugin-hooks',
          `plugin "${plugin.name}" defines matching batch and single hooks; define one form per phase before 3.0.`
        );
      }
      this.pluginRegistry.push({ plugin, order: this.orderCounter++ });
    }
    this.sortPlugins();
    this.validatePluginCombinations();
  }

  private sortPlugins(): void {
    this.pluginRegistry.sort((a, b) => {
      const priorityA = a.plugin.priority ?? 0;
      const priorityB = b.plugin.priority ?? 0;
      if (priorityA === priorityB) {
        return a.order - b.order;
      }
      return priorityB - priorityA;
    });
  }

  private getActivePlugins(options?: {
    reverse?: boolean;
  }): LocalSpacePlugin[] {
    const reverse = options?.reverse ?? false;
    const plugins = this.pluginRegistry
      .map((entry) => entry.plugin)
      .filter((plugin) => {
        if (this.disabled.has(plugin)) {
          return false;
        }
        const enabled = plugin.enabled;
        if (typeof enabled === 'function') {
          try {
            return !!enabled();
          } catch (error) {
            console.warn(
              `Plugin "${plugin.name}" enabled() check failed`,
              error
            );
            return false;
          }
        }
        return enabled !== false;
      });
    return reverse ? plugins.slice().reverse() : plugins;
  }

  ensureInitialized(): Promise<void> {
    const initializationPass = this.initializePlugins();
    this.initializationPasses.add(initializationPass);
    const stopTracking = () => {
      this.initializationPasses.delete(initializationPass);
    };
    void initializationPass.then(stopTracking, stopTracking);
    return initializationPass;
  }

  private async initializePlugins(): Promise<void> {
    for (const plugin of this.getActivePlugins()) {
      if (this.initialized.has(plugin)) {
        continue;
      }

      if (typeof plugin.onInit !== 'function') {
        this.initialized.add(plugin);
        continue;
      }

      const pendingInit = this.initPromises.get(plugin);
      if (pendingInit) {
        await pendingInit;
        continue;
      }

      const lifecycle = this.lifecycleBridge.createInvocation('plugin-init');
      const context = this.createContext(null, lifecycle.instance);
      const initPromise = (async () => {
        try {
          await lifecycle.invoke(() => plugin.onInit!(context));
          this.initialized.add(plugin);
        } catch (error) {
          await this.dispatchPluginError(
            plugin,
            error,
            'init',
            'lifecycle',
            undefined,
            context
          );
          const policy = this.host._config.pluginInitPolicy ?? 'fail';
          if (policy === 'disable-and-continue') {
            this.disabled.add(plugin);
            return;
          }
          throw error;
        } finally {
          this.initPromises.delete(plugin);
        }
      })();

      this.initPromises.set(plugin, initPromise);
      await initPromise;
    }
  }

  createContext(
    operation: PluginOperation | null,
    instance: LocalSpaceInstance = this.host
  ): PluginContext {
    return {
      instance,
      driver: this.host.driver ? this.host.driver() : null,
      dbInfo: this.host._dbInfo ?? null,
      config: this.host._config,
      metadata: this.sharedMetadata,
      operation,
      operationState: Object.create(null),
    };
  }

  async beforeSet<T>(
    key: string,
    value: T,
    context: PluginContext
  ): Promise<T> {
    let current = value;
    for (const plugin of this.getActivePlugins()) {
      if (!plugin.beforeSet) continue;
      current = await this.invokeValueHook(
        plugin,
        () => plugin.beforeSet!(key, current, context),
        'before',
        'setItem',
        key,
        context,
        current
      );
    }
    return current;
  }

  async afterSet<T>(
    key: string,
    value: T,
    context: PluginContext
  ): Promise<void> {
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (!plugin.afterSet) continue;
      await this.invokeVoidHook(
        plugin,
        () => plugin.afterSet!(key, value, context),
        'after',
        'setItem',
        key,
        context
      );
    }
  }

  async beforeGet(key: string, context: PluginContext): Promise<string> {
    let currentKey = key;
    for (const plugin of this.getActivePlugins()) {
      if (!plugin.beforeGet) continue;
      currentKey = await this.invokeValueHook(
        plugin,
        () => plugin.beforeGet!(currentKey, context),
        'before',
        'getItem',
        currentKey,
        context,
        currentKey
      );
    }
    return currentKey;
  }

  async afterGet<T>(
    key: string,
    value: T | null,
    context: PluginContext
  ): Promise<T | null> {
    let currentValue: T | null = value;
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (!plugin.afterGet) continue;
      currentValue = await this.invokeValueHook(
        plugin,
        () => plugin.afterGet!(key, currentValue, context),
        'after',
        'getItem',
        key,
        context,
        currentValue
      );
    }
    return currentValue;
  }

  async beforeRemove(key: string, context: PluginContext): Promise<string> {
    let currentKey = key;
    for (const plugin of this.getActivePlugins()) {
      if (!plugin.beforeRemove) continue;
      currentKey = await this.invokeValueHook(
        plugin,
        () => plugin.beforeRemove!(currentKey, context),
        'before',
        'removeItem',
        currentKey,
        context,
        currentKey
      );
    }
    return currentKey;
  }

  async afterRemove(key: string, context: PluginContext): Promise<void> {
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (!plugin.afterRemove) continue;
      await this.invokeVoidHook(
        plugin,
        () => plugin.afterRemove!(key, context),
        'after',
        'removeItem',
        key,
        context
      );
    }
  }

  async beforeSetItems<T>(
    entries: BatchItems<T>,
    context: PluginContext
  ): Promise<PreparedSetItems<T>> {
    let current = entries;
    let lineage = createBatchLineage(entries);
    let hasStorageTransforms = false;
    for (const plugin of this.getActivePlugins()) {
      const isStorageTransform =
        getBuiltInStorageTransformKind(plugin) !== null;
      hasStorageTransforms ||= isStorageTransform;
      if (!plugin.beforeSetItems) continue;
      current = await this.invokeValueHook(
        plugin,
        () => plugin.beforeSetItems!(current, context),
        'before',
        'setItems',
        undefined,
        context,
        current
      );
      lineage = updateBatchLineage(lineage, current, isStorageTransform);
    }
    return {
      entries: current,
      logicalEntries: lineage.map(({ key, logicalValue }) => ({
        key,
        value: logicalValue,
      })),
      hasStorageTransforms,
    };
  }

  async afterSetItems<T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> {
    let current = entries;
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (!plugin.afterSetItems) continue;
      current = await this.invokeValueHook(
        plugin,
        () => plugin.afterSetItems!(current, context),
        'after',
        'setItems',
        undefined,
        context,
        current
      );
    }
    return current;
  }

  async beforeGetItems(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> {
    let currentKeys = keys;
    for (const plugin of this.getActivePlugins()) {
      if (!plugin.beforeGetItems) continue;
      currentKeys = await this.invokeValueHook(
        plugin,
        () => plugin.beforeGetItems!(currentKeys, context),
        'before',
        'getItems',
        undefined,
        context,
        currentKeys
      );
    }
    return currentKeys;
  }

  async afterGetItems<T>(
    entries: BatchResponse<T>,
    context: PluginContext
  ): Promise<BatchResponse<T>> {
    let current = entries;
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (!plugin.afterGetItems) continue;
      current = await this.invokeValueHook(
        plugin,
        () => plugin.afterGetItems!(current, context),
        'after',
        'getItems',
        undefined,
        context,
        current
      );
    }
    return current;
  }

  async beforeRemoveItems(
    keys: string[],
    context: PluginContext
  ): Promise<string[]> {
    let currentKeys = keys;
    for (const plugin of this.getActivePlugins()) {
      if (!plugin.beforeRemoveItems) continue;
      currentKeys = await this.invokeValueHook(
        plugin,
        () => plugin.beforeRemoveItems!(currentKeys, context),
        'before',
        'removeItems',
        undefined,
        context,
        currentKeys
      );
    }
    return currentKeys;
  }

  async afterRemoveItems(
    keys: string[],
    context: PluginContext
  ): Promise<void> {
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (!plugin.afterRemoveItems) continue;
      await this.invokeVoidHook(
        plugin,
        () => plugin.afterRemoveItems!(keys, context),
        'after',
        'removeItems',
        undefined,
        context
      );
    }
  }

  async destroy(): Promise<void> {
    await this.destroyPlugins(false);
  }

  async destroyInitialized(): Promise<void> {
    while (this.initializationPasses.size > 0) {
      await Promise.allSettled([...this.initializationPasses]);
    }
    await this.destroyPlugins(true);
  }

  pauseBackgroundTasks(): PluginBackgroundTaskPause {
    const pauses: PluginBackgroundTaskPause[] = [];
    try {
      for (const { plugin } of this.pluginRegistry) {
        if (!this.initialized.has(plugin) || this.destroyed.has(plugin)) {
          continue;
        }
        const controller = getPluginBackgroundTaskController(plugin);
        if (controller) {
          pauses.push(controller(this.createContext(null)));
        }
      }
    } catch (error) {
      for (const pause of pauses.slice().reverse()) {
        pause.resume();
      }
      throw error;
    }

    let resumed = false;
    return {
      pending: pauses.some((pause) => pause.pending),
      settled: Promise.all(pauses.map((pause) => pause.settled)).then(
        () => undefined
      ),
      resume: () => {
        if (resumed) {
          return;
        }
        resumed = true;
        for (const pause of pauses.slice().reverse()) {
          pause.resume();
        }
      },
    };
  }

  private async destroyPlugins(initializedOnly: boolean): Promise<void> {
    const plugins = this.pluginRegistry
      .map((entry) => entry.plugin)
      .slice()
      .reverse();
    for (const plugin of plugins) {
      if (initializedOnly && !this.initialized.has(plugin)) {
        continue;
      }
      if (this.destroyed.has(plugin) || this.disabled.has(plugin)) {
        continue;
      }
      const pendingDestroy = this.destroyPromises.get(plugin);
      if (pendingDestroy) {
        await pendingDestroy;
        continue;
      }
      if (typeof plugin.onDestroy !== 'function') {
        this.destroyed.add(plugin);
        continue;
      }
      const lifecycle = this.lifecycleBridge.createInvocation('plugin-destroy');
      const context = this.createContext(null, lifecycle.instance);
      const destroyPromise = Promise.resolve().then(async () => {
        try {
          await lifecycle.invoke(() => plugin.onDestroy!(context));
        } catch (error) {
          await this.dispatchPluginError(
            plugin,
            error,
            'destroy',
            'lifecycle',
            undefined,
            context
          );
        } finally {
          this.destroyed.add(plugin);
        }
      });
      this.destroyPromises.set(plugin, destroyPromise);
      await destroyPromise;
    }
  }

  normalizeBatch<T>(items: BatchItems<T>): Array<{ key: string; value: T }> {
    return normalizeBatchEntries(items);
  }

  private shouldPropagate(
    error: unknown,
    policy: 'strict' | 'lenient'
  ): boolean {
    return (
      policy === 'strict' ||
      error instanceof LocalSpaceError ||
      error instanceof PluginAbortError
    );
  }

  private async dispatchPluginError(
    plugin: LocalSpacePlugin,
    error: unknown,
    stage: PluginStage,
    operation: PluginOperation,
    key: string | undefined,
    context: PluginContext
  ): Promise<void> {
    const info: PluginErrorInfo = {
      plugin: plugin.name,
      operation,
      stage,
      key,
      context,
      error,
    };

    if (typeof plugin.onError === 'function') {
      try {
        await plugin.onError(error, info);
        return;
      } catch (hookError) {
        console.error(
          `Plugin onError handler failed for "${plugin.name}"`,
          hookError
        );
      }
    }

    console.warn(`Plugin "${plugin.name}" error during ${operation}`, error);
  }

  private async invokeValueHook<T>(
    plugin: LocalSpacePlugin,
    executor: () => Promise<T> | T,
    stage: PluginStage,
    operation: PluginOperation,
    key: string | undefined,
    context: PluginContext,
    fallback: T
  ): Promise<T> {
    try {
      const result = await executor();
      return (typeof result === 'undefined' ? fallback : result) as T;
    } catch (error) {
      const policy = this.host._config.pluginErrorPolicy ?? 'lenient';
      if (this.shouldPropagate(error, policy)) {
        throw error;
      }
      await this.dispatchPluginError(
        plugin,
        error,
        stage,
        operation,
        key,
        context
      );
      return fallback;
    }
  }

  private async invokeVoidHook(
    plugin: LocalSpacePlugin,
    executor: () => Promise<void> | void,
    stage: PluginStage,
    operation: PluginOperation,
    key: string | undefined,
    context: PluginContext
  ): Promise<void> {
    try {
      await executor();
    } catch (error) {
      const policy = this.host._config.pluginErrorPolicy ?? 'lenient';
      if (this.shouldPropagate(error, policy)) {
        throw error;
      }
      await this.dispatchPluginError(
        plugin,
        error,
        stage,
        operation,
        key,
        context
      );
    }
  }
}
