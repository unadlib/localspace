import type {
  BatchItems,
  BatchResponse,
  DbInfo,
  LocalSpaceConfigSnapshot,
  LocalSpaceInstance,
  LocalSpacePlugin,
  PluginContext,
  PluginErrorInfo,
  PluginIterateSummary,
  PluginOperation,
  PluginStage,
} from '../types.js';
import { createLocalSpaceError, LocalSpaceError } from '../errors.js';
import { normalizeBatchEntries } from '../utils/helpers.js';
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

type PluginHost = LocalSpaceInstance;

type PluginLifecycleInvocation = {
  instance: LocalSpaceInstance;
  invoke<T>(callback: () => T): Promise<Awaited<T>>;
};

type PluginLifecycleBridge = {
  createInvocation(
    lifecycle: 'plugin-init' | 'plugin-destroy'
  ): PluginLifecycleInvocation;
  getDbInfo(): DbInfo | null;
};

type RegisteredPlugin = {
  plugin: LocalSpacePlugin;
  order: number;
};

type PluginHookRole = 'all' | 'logical' | 'storage-transform';

type PreparedSetItem<T> = {
  key: string;
  value: T;
  logicalValue: T;
  context: PluginContext;
};

type PreparedSetItems<T> = {
  entries: Array<{ key: string; value: T }>;
  logicalEntries: Array<{ key: string; value: T }>;
  items: PreparedSetItem<T>[];
};

type PreparedKeyItem = {
  requestedKey: string;
  targetKey: string;
  context: PluginContext;
};

type PreparedKeys = {
  keys: string[];
  items: PreparedKeyItem[];
};

type PreparedBatchResponse<T> = {
  entries: BatchResponse<T>;
  items: PreparedKeyItem[];
};

type BeforeSetItemsOptions<T> = {
  role?: PluginHookRole;
  preserveLogicalValues?: boolean;
  prepareBatchOutput?: (
    entries: BatchItems<T>,
    plugin: LocalSpacePlugin
  ) => BatchItems<T>;
  prepareValueOutput?: (value: T, plugin: LocalSpacePlugin, key: string) => T;
};

const sharedMetadataFor = (): Record<string, unknown> => Object.create(null);

/**
 * Plugin combination warnings to help users avoid problematic configurations.
 */
const PLUGIN_WARNINGS = {
  LENIENT_WITH_COMPRESSION: {
    condition: (
      plugins: LocalSpacePlugin[],
      config: LocalSpaceConfigSnapshot
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
    const config = this.host.config();

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

  assertNoStorageTransformBypass(operation: 'runTransaction'): void {
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

  needsLogicalReadScan(): boolean {
    return this.getActivePlugins().some(
      (plugin) =>
        getBuiltInStorageTransformKind(plugin) !== null ||
        typeof plugin.afterGet === 'function' ||
        typeof plugin.afterGetItems === 'function'
    );
  }

  registerPlugins(plugins: LocalSpacePlugin[]): void {
    const existingNames = new Set(
      this.pluginRegistry.map(({ plugin }) => plugin.name)
    );
    const pendingNames = new Set<string>();
    for (const plugin of plugins) {
      if (!plugin) continue;
      if (
        typeof plugin.name !== 'string' ||
        plugin.name.length === 0 ||
        existingNames.has(plugin.name) ||
        pendingNames.has(plugin.name)
      ) {
        throw createLocalSpaceError(
          'INVALID_CONFIG',
          `Plugin name "${String(plugin?.name ?? '')}" must be unique.`,
          {
            configKey: 'plugins',
            plugin: plugin?.name,
            reason:
              typeof plugin?.name === 'string' && plugin.name.length > 0
                ? 'duplicate-plugin'
                : 'invalid-plugin-name',
          }
        );
      }
      pendingNames.add(plugin.name);
    }

    for (const plugin of plugins) {
      if (!plugin) continue;
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
    role?: PluginHookRole;
  }): LocalSpacePlugin[] {
    const reverse = options?.reverse ?? false;
    const role = options?.role ?? 'all';
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
      })
      .filter((plugin) => {
        if (role === 'all') return true;
        const isStorageTransform =
          getBuiltInStorageTransformKind(plugin) !== null;
        return role === 'storage-transform'
          ? isStorageTransform
          : !isStorageTransform;
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
          const policy = this.host.config('pluginInitPolicy') ?? 'fail';
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
    lifecycleInstance?: LocalSpaceInstance
  ): PluginContext {
    return {
      instance: this.host,
      ...(lifecycleInstance ? { lifecycleInstance } : {}),
      driver: this.host.driver ? this.host.driver() : null,
      dbInfo: this.lifecycleBridge.getDbInfo(),
      config: this.host.config(),
      metadata: this.sharedMetadata,
      operation,
      operationState: Object.create(null),
    };
  }

  async beforeSet<T>(
    key: string,
    value: T,
    context: PluginContext,
    prepareOutput?: (value: T, plugin: LocalSpacePlugin) => T,
    role: PluginHookRole = 'all'
  ): Promise<T> {
    let current = value;
    for (const plugin of this.getActivePlugins({ role })) {
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
      if (prepareOutput) {
        current = prepareOutput(current, plugin);
      }
    }
    return current;
  }

  async afterSet<T>(
    key: string,
    value: T,
    context: PluginContext,
    role: PluginHookRole = 'all'
  ): Promise<void> {
    for (const plugin of this.getActivePlugins({ reverse: true, role })) {
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
    context: PluginContext,
    role: PluginHookRole = 'all'
  ): Promise<T | null> {
    let currentValue: T | null = value;
    for (const plugin of this.getActivePlugins({ reverse: true, role })) {
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
    context: PluginContext,
    options: BeforeSetItemsOptions<T> = {}
  ): Promise<PreparedSetItems<T>> {
    const role = options.role ?? 'all';
    const preserveLogicalValues = options.preserveLogicalValues ?? false;
    const createItem = (
      key: string,
      value: T,
      logicalValue: T = value
    ): PreparedSetItem<T> => {
      const entryContext = this.createContext('setItem');
      entryContext.operationState.isBatch = true;
      entryContext.operationState.originalValue = logicalValue;
      return { key, value, logicalValue, context: entryContext };
    };
    let current = normalizeBatchEntries(entries).map(({ key, value }) =>
      createItem(key, value)
    );

    const updateBatchSize = (): void => {
      context.operationState.batchSize = current.length;
      for (const item of current) {
        item.context.operationState.batchSize = current.length;
      }
    };
    updateBatchSize();

    for (const plugin of this.getActivePlugins({ role })) {
      if (plugin.beforeSetItems) {
        const input = current.map(({ key, value }) => ({ key, value }));
        let output = await this.invokeValueHook(
          plugin,
          () => plugin.beforeSetItems!(input, context),
          'before',
          'setItems',
          undefined,
          context,
          input
        );
        if (options.prepareBatchOutput) {
          output = options.prepareBatchOutput(output, plugin);
        }

        const previousByKey = new Map<string, PreparedSetItem<T>[]>();
        for (const item of current) {
          const matches = previousByKey.get(item.key) ?? [];
          matches.push(item);
          previousByKey.set(item.key, matches);
        }
        current = normalizeBatchEntries(output).map(({ key, value }) => {
          const previous = previousByKey.get(key)?.shift();
          if (!previous) {
            return createItem(key, value);
          }
          const logicalValue =
            preserveLogicalValues || Object.is(value, previous.value)
              ? previous.logicalValue
              : value;
          previous.key = key;
          previous.value = value;
          previous.logicalValue = logicalValue;
          previous.context.operationState.originalValue = logicalValue;
          return previous;
        });
        if (options.prepareValueOutput) {
          for (const item of current) {
            const pluginValue = item.value;
            const preparedValue = options.prepareValueOutput(
              pluginValue,
              plugin,
              item.key
            );
            item.value = preparedValue;
            if (Object.is(item.logicalValue, pluginValue)) {
              item.logicalValue = preparedValue;
              item.context.operationState.originalValue = preparedValue;
            }
          }
        }
        updateBatchSize();
        continue;
      }

      if (!plugin.beforeSet) continue;
      for (const item of current) {
        let value = (await this.invokeValueHook(
          plugin,
          () => plugin.beforeSet!(item.key, item.value, item.context),
          'before',
          'setItems',
          item.key,
          item.context,
          item.value
        )) as T;
        if (options.prepareValueOutput) {
          value = options.prepareValueOutput(value, plugin, item.key);
        }
        item.value = value;
      }
    }

    return {
      entries: current.map(({ key, value }) => ({ key, value })),
      logicalEntries: current.map(({ key, logicalValue }) => ({
        key,
        value: logicalValue,
      })),
      items: current,
    };
  }

  async afterSetItems<T>(
    entries: BatchResponse<T>,
    context: PluginContext,
    preparedItems: PreparedSetItem<T>[],
    role: PluginHookRole = 'all'
  ): Promise<BatchResponse<T>> {
    let current = entries;
    let items = preparedItems.slice();

    const reconcileItems = (): void => {
      const previousByKey = new Map<string, PreparedSetItem<T>[]>();
      for (const item of items) {
        const matches = previousByKey.get(item.key) ?? [];
        matches.push(item);
        previousByKey.set(item.key, matches);
      }
      items = current.map(({ key, value }) => {
        const previous = previousByKey.get(key)?.shift();
        if (previous) {
          previous.key = key;
          return previous;
        }
        const entryContext = this.createContext('setItem');
        entryContext.operationState.isBatch = true;
        entryContext.operationState.originalValue = value;
        return {
          key,
          value: value as T,
          logicalValue: value as T,
          context: entryContext,
        };
      });
      context.operationState.batchSize = current.length;
      for (const item of items) {
        item.context.operationState.batchSize = current.length;
      }
    };
    reconcileItems();

    for (const plugin of this.getActivePlugins({ reverse: true, role })) {
      if (plugin.afterSetItems) {
        current = await this.invokeValueHook(
          plugin,
          () => plugin.afterSetItems!(current, context),
          'after',
          'setItems',
          undefined,
          context,
          current
        );
        reconcileItems();
        continue;
      }

      if (!plugin.afterSet) continue;
      for (let index = 0; index < current.length; index++) {
        const entry = current[index];
        const item = items[index];
        await this.invokeVoidHook(
          plugin,
          () => plugin.afterSet!(entry.key, entry.value as T, item.context),
          'after',
          'setItems',
          entry.key,
          item.context
        );
      }
    }

    return current.map((entry, index) => {
      const operationState = items[index]?.context.operationState;
      const hasReturnValue =
        !!operationState &&
        Object.prototype.hasOwnProperty.call(operationState, 'returnValue');
      return {
        key: entry.key,
        value: hasReturnValue
          ? (operationState.returnValue as T | null)
          : entry.value,
      };
    });
  }

  private createPreparedKeyItem(
    key: string,
    operation: PluginOperation
  ): PreparedKeyItem {
    const context = this.createContext(operation);
    context.operationState.isBatch = true;
    return { requestedKey: key, targetKey: key, context };
  }

  private updateBatchContexts(
    items: PreparedKeyItem[],
    context: PluginContext
  ): void {
    context.operationState.batchSize = items.length;
    for (const item of items) {
      item.context.operationState.isBatch = true;
      item.context.operationState.batchSize = items.length;
    }
  }

  private reconcilePreparedKeyItems(
    previousItems: PreparedKeyItem[],
    keys: string[],
    operation: PluginOperation
  ): PreparedKeyItem[] {
    const previousByKey = new Map<string, PreparedKeyItem[]>();
    for (const item of previousItems) {
      const matches = previousByKey.get(item.targetKey) ?? [];
      matches.push(item);
      previousByKey.set(item.targetKey, matches);
    }
    return keys.map((targetKey) => {
      const previous = previousByKey.get(targetKey)?.shift();
      if (previous) {
        previous.targetKey = targetKey;
        return previous;
      }
      return this.createPreparedKeyItem(targetKey, operation);
    });
  }

  private async beforeKeyItems(
    keys: string[],
    context: PluginContext,
    operation: 'getItems' | 'removeItems'
  ): Promise<PreparedKeys> {
    const itemOperation = operation === 'getItems' ? 'getItem' : 'removeItem';
    let items = keys.map((key) =>
      this.createPreparedKeyItem(key, itemOperation)
    );
    this.updateBatchContexts(items, context);

    for (const plugin of this.getActivePlugins()) {
      const hasBatchHook =
        operation === 'getItems'
          ? typeof plugin.beforeGetItems === 'function'
          : typeof plugin.beforeRemoveItems === 'function';
      if (hasBatchHook) {
        const input = items.map(({ targetKey }) => targetKey);
        const output = await this.invokeValueHook(
          plugin,
          () =>
            operation === 'getItems'
              ? plugin.beforeGetItems!(input, context)
              : plugin.beforeRemoveItems!(input, context),
          'before',
          operation,
          undefined,
          context,
          input
        );
        items = this.reconcilePreparedKeyItems(items, output, itemOperation);
        this.updateBatchContexts(items, context);
        continue;
      }

      const hasSingleHook =
        operation === 'getItems'
          ? typeof plugin.beforeGet === 'function'
          : typeof plugin.beforeRemove === 'function';
      if (!hasSingleHook) continue;
      for (const item of items) {
        item.targetKey = await this.invokeValueHook(
          plugin,
          () =>
            operation === 'getItems'
              ? plugin.beforeGet!(item.targetKey, item.context)
              : plugin.beforeRemove!(item.targetKey, item.context),
          'before',
          operation,
          item.targetKey,
          item.context,
          item.targetKey
        );
      }
    }

    return {
      keys: items.map(({ targetKey }) => targetKey),
      items,
    };
  }

  async beforeGetItems(
    keys: string[],
    context: PluginContext
  ): Promise<PreparedKeys> {
    return this.beforeKeyItems(keys, context, 'getItems');
  }

  prepareReadItems(keys: string[], context: PluginContext): PreparedKeys {
    const operation = context.operation ?? 'getItems';
    const items = keys.map((key) => this.createPreparedKeyItem(key, operation));
    this.updateBatchContexts(items, context);
    return { keys: keys.slice(), items };
  }

  async afterGetItems<T>(
    entries: BatchResponse<T>,
    context: PluginContext,
    preparedItems: PreparedKeyItem[],
    role: PluginHookRole = 'all',
    operation: PluginOperation = 'getItems'
  ): Promise<PreparedBatchResponse<T>> {
    let current = entries;
    let items = preparedItems.slice();

    const reconcileItems = (): void => {
      items = this.reconcilePreparedKeyItems(
        items,
        current.map(({ key }) => key),
        operation === 'getItems' ? 'getItem' : operation
      );
      this.updateBatchContexts(items, context);
    };
    reconcileItems();

    for (const plugin of this.getActivePlugins({ reverse: true, role })) {
      if (plugin.afterGetItems) {
        current = await this.invokeValueHook(
          plugin,
          () => plugin.afterGetItems!(current, context),
          'after',
          operation,
          undefined,
          context,
          current
        );
        reconcileItems();
        continue;
      }

      if (!plugin.afterGet) continue;
      const mapped: BatchResponse<T> = [];
      for (let index = 0; index < current.length; index++) {
        const entry = current[index];
        mapped.push({
          key: entry.key,
          value: await this.invokeValueHook(
            plugin,
            () =>
              plugin.afterGet!(entry.key, entry.value, items[index].context),
            'after',
            operation,
            entry.key,
            items[index].context,
            entry.value
          ),
        });
      }
      current = mapped;
    }
    return { entries: current, items };
  }

  async beforeRemoveItems(
    keys: string[],
    context: PluginContext
  ): Promise<PreparedKeys> {
    return this.beforeKeyItems(keys, context, 'removeItems');
  }

  async afterRemoveItems(
    keys: string[],
    context: PluginContext,
    preparedItems: PreparedKeyItem[]
  ): Promise<void> {
    const items = preparedItems.slice();
    context.operationState.batchSize = keys.length;
    for (const plugin of this.getActivePlugins({ reverse: true })) {
      if (plugin.afterRemoveItems) {
        await this.invokeVoidHook(
          plugin,
          () => plugin.afterRemoveItems!(keys, context),
          'after',
          'removeItems',
          undefined,
          context
        );
        continue;
      }

      if (!plugin.afterRemove) continue;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const item = items[index] ?? {
          requestedKey: key,
          targetKey: key,
          context: this.createContext('removeItem'),
        };
        item.context.operationState.isBatch = true;
        item.context.operationState.batchSize = keys.length;
        await this.invokeVoidHook(
          plugin,
          () => plugin.afterRemove!(key, item.context),
          'after',
          'removeItems',
          key,
          item.context
        );
      }
    }
  }

  private async invokeOperationObservers(
    operation: PluginOperation,
    stage: 'before' | 'after',
    context: PluginContext,
    executorFor: (
      plugin: LocalSpacePlugin
    ) => (() => Promise<void> | void) | undefined,
    key?: string
  ): Promise<void> {
    for (const plugin of this.getActivePlugins({
      reverse: stage === 'after',
    })) {
      const executor = executorFor(plugin);
      if (!executor) continue;
      await this.invokeVoidHook(
        plugin,
        executor,
        stage,
        operation,
        key,
        context
      );
    }
  }

  beforeIterate(context: PluginContext): Promise<void> {
    return this.invokeOperationObservers(
      'iterate',
      'before',
      context,
      (plugin) =>
        plugin.beforeIterate ? () => plugin.beforeIterate!(context) : undefined
    );
  }

  afterIterate(
    summary: PluginIterateSummary,
    context: PluginContext
  ): Promise<void> {
    const snapshot = Object.freeze({ ...summary });
    return this.invokeOperationObservers(
      'iterate',
      'after',
      context,
      (plugin) =>
        plugin.afterIterate
          ? () => plugin.afterIterate!(snapshot, context)
          : undefined
    );
  }

  beforeKeys(context: PluginContext): Promise<void> {
    return this.invokeOperationObservers('keys', 'before', context, (plugin) =>
      plugin.beforeKeys ? () => plugin.beforeKeys!(context) : undefined
    );
  }

  afterKeys(keys: string[], context: PluginContext): Promise<void> {
    const snapshot = Object.freeze(keys.slice());
    return this.invokeOperationObservers('keys', 'after', context, (plugin) =>
      plugin.afterKeys ? () => plugin.afterKeys!(snapshot, context) : undefined
    );
  }

  beforeKey(keyIndex: number, context: PluginContext): Promise<void> {
    return this.invokeOperationObservers('key', 'before', context, (plugin) =>
      plugin.beforeKey ? () => plugin.beforeKey!(keyIndex, context) : undefined
    );
  }

  afterKey(
    keyIndex: number,
    key: string | null,
    context: PluginContext
  ): Promise<void> {
    return this.invokeOperationObservers(
      'key',
      'after',
      context,
      (plugin) =>
        plugin.afterKey
          ? () => plugin.afterKey!(keyIndex, key, context)
          : undefined,
      key ?? undefined
    );
  }

  beforeLength(context: PluginContext): Promise<void> {
    return this.invokeOperationObservers(
      'length',
      'before',
      context,
      (plugin) =>
        plugin.beforeLength ? () => plugin.beforeLength!(context) : undefined
    );
  }

  afterLength(length: number, context: PluginContext): Promise<void> {
    return this.invokeOperationObservers(
      'length',
      'after',
      context,
      (plugin) =>
        plugin.afterLength
          ? () => plugin.afterLength!(length, context)
          : undefined
    );
  }

  beforeClear(context: PluginContext): Promise<void> {
    return this.invokeOperationObservers(
      'clear',
      'before',
      context,
      (plugin) =>
        plugin.beforeClear ? () => plugin.beforeClear!(context) : undefined
    );
  }

  afterClear(context: PluginContext): Promise<void> {
    return this.invokeOperationObservers('clear', 'after', context, (plugin) =>
      plugin.afterClear ? () => plugin.afterClear!(context) : undefined
    );
  }

  beforeDropInstance(
    options: LocalSpaceConfigSnapshot | undefined,
    context: PluginContext
  ): Promise<void> {
    return this.invokeOperationObservers(
      'dropInstance',
      'before',
      context,
      (plugin) =>
        plugin.beforeDropInstance
          ? () => plugin.beforeDropInstance!(options, context)
          : undefined
    );
  }

  afterDropInstance(
    options: LocalSpaceConfigSnapshot | undefined,
    context: PluginContext
  ): Promise<void> {
    return this.invokeOperationObservers(
      'dropInstance',
      'after',
      context,
      (plugin) =>
        plugin.afterDropInstance
          ? () => plugin.afterDropInstance!(options, context)
          : undefined
    );
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
      const policy = this.host.config('pluginErrorPolicy') ?? 'lenient';
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
      const policy = this.host.config('pluginErrorPolicy') ?? 'lenient';
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
