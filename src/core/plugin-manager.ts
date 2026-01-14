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

  constructor(host: PluginHost, initialPlugins: LocalSpacePlugin[] = []) {
    this.host = host;
    if (initialPlugins.length) {
      this.registerPlugins(initialPlugins);
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
