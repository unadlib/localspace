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
} from '../types';
import { LocalSpaceError } from '../errors';
import { normalizeBatchEntries } from '../utils/helpers';

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

type RegisteredPlugin = {
  plugin: LocalSpacePlugin;
  order: number;
};

const sharedMetadataFor = (): Record<string, unknown> => Object.create(null);

/**
 * Plugin combination warnings to help users avoid problematic configurations.
 */
const PLUGIN_WARNINGS = {
  LENIENT_WITH_ENCRYPTION: {
    condition: (
      plugins: LocalSpacePlugin[],
      config: PluginHost['_config']
    ): boolean => {
      const hasEncryption = plugins.some((p) => p.name === 'encryption');
      return hasEncryption && config.pluginErrorPolicy === 'lenient';
    },
    message:
      '[localspace] Warning: Using lenient error policy with encryption plugin may silently fail decryption. Consider using strict policy for security-critical plugins.',
  },
  LENIENT_WITH_COMPRESSION: {
    condition: (
      plugins: LocalSpacePlugin[],
      config: PluginHost['_config']
    ): boolean => {
      const hasCompression = plugins.some((p) => p.name === 'compression');
      return hasCompression && config.pluginErrorPolicy === 'lenient';
    },
    message:
      '[localspace] Warning: Using lenient error policy with compression plugin may cause data corruption if decompression fails.',
  },
  ENCRYPTION_BEFORE_COMPRESSION: {
    condition: (plugins: LocalSpacePlugin[]): boolean => {
      const encIdx = plugins.findIndex((p) => p.name === 'encryption');
      const compIdx = plugins.findIndex((p) => p.name === 'compression');
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
  QUOTA_NOT_LAST: {
    condition: (plugins: LocalSpacePlugin[]): boolean => {
      const quotaPlugin = plugins.find((p) => p.name === 'quota');
      if (!quotaPlugin) return false;
      const quotaPriority = quotaPlugin.priority ?? 0;
      // Quota should have one of the lowest priorities to measure final size
      // Only sync should be lower
      const hasHigherPriorityAfter = plugins.some(
        (p) =>
          p.name !== 'quota' &&
          p.name !== 'sync' &&
          (p.priority ?? 0) < quotaPriority
      );
      return hasHigherPriorityAfter;
    },
    message:
      '[localspace] Warning: Quota plugin may not measure final payload sizes correctly. Consider giving it a lower priority than transformation plugins (TTL, compression, encryption).',
  },
} as const;

export class PluginManager {
  private readonly host: PluginHost;

  private readonly sharedMetadata: Record<string, unknown> =
    sharedMetadataFor();

  private readonly pluginRegistry: RegisteredPlugin[] = [];

  private readonly initialized = new WeakSet<LocalSpacePlugin>();

  private readonly initPromises = new WeakMap<
    LocalSpacePlugin,
    Promise<void>
  >();

  private readonly destroyed = new WeakSet<LocalSpacePlugin>();

  private readonly disabled = new WeakSet<LocalSpacePlugin>();

  private orderCounter = 0;

  private warningsEmitted = new Set<string>();

  constructor(host: PluginHost, initialPlugins: LocalSpacePlugin[] = []) {
    this.host = host;
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

  registerPlugins(plugins: LocalSpacePlugin[]): void {
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

  async ensureInitialized(): Promise<void> {
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

      const context = this.createContext(null);
      const initPromise = (async () => {
        try {
          await plugin.onInit!(context);
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

  createContext(operation: PluginOperation | null): PluginContext {
    return {
      instance: this.host,
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
  ): Promise<BatchItems<T>> {
    let current = entries;
    for (const plugin of this.getActivePlugins()) {
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
    }
    return current;
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
    const plugins = this.pluginRegistry
      .map((entry) => entry.plugin)
      .slice()
      .reverse();
    for (const plugin of plugins) {
      if (this.destroyed.has(plugin) || this.disabled.has(plugin)) {
        continue;
      }
      if (typeof plugin.onDestroy !== 'function') {
        this.destroyed.add(plugin);
        continue;
      }
      const context = this.createContext(null);
      try {
        await plugin.onDestroy(context);
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
      const policy = this.host._config.pluginErrorPolicy ?? 'strict';
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
      const policy = this.host._config.pluginErrorPolicy ?? 'strict';
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
