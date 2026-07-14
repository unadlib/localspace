export type LocalSpaceDeprecation =
  | 'legacy-encryption-algorithm'
  | 'legacy-size-option'
  | 'destroy'
  | 'mutable-config-reference'
  | 'combined-plugin-hooks'
  | 'react-native-auto-detection';

type DeprecationState = {
  emitted: Set<LocalSpaceDeprecation>;
  enabled: boolean;
};

const DEPRECATION_STATE_KEY = Symbol.for(
  'localspace.v2.deprecation-warning-state'
);

const isDeprecationState = (value: unknown): value is DeprecationState => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<DeprecationState>;
  return candidate.emitted instanceof Set && typeof candidate.enabled === 'boolean';
};

const getDeprecationState = (): DeprecationState => {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DEPRECATION_STATE_KEY];
  if (isDeprecationState(existing)) {
    return existing;
  }

  const created: DeprecationState = {
    emitted: new Set<LocalSpaceDeprecation>(),
    enabled: true,
  };
  Object.defineProperty(globalRecord, DEPRECATION_STATE_KEY, {
    value: created,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return created;
};

const deprecationState = getDeprecationState();

const isProductionRuntime = (): boolean => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.NODE_ENV === 'production';
  }

  // Direct browser bundles have no standard runtime environment flag. They
  // use the build-time production fallback while consumer bundlers and Node
  // can still replace/read NODE_ENV dynamically.
  return typeof __DEV__ === 'undefined' || !__DEV__;
};

/**
 * Enable or disable development-only deprecation warnings globally for the
 * every localspace entry point loaded in the current JavaScript realm.
 */
export const setDeprecationWarnings = (enabled: boolean): void => {
  deprecationState.enabled = enabled;
};

export const warnDeprecation = (
  deprecation: LocalSpaceDeprecation,
  message: string
): void => {
  if (
    !deprecationState.enabled ||
    isProductionRuntime() ||
    deprecationState.emitted.has(deprecation)
  ) {
    return;
  }

  deprecationState.emitted.add(deprecation);
  console.warn(`[localspace] Deprecation: ${message}`);
};

export const resetDeprecationWarningsForTests = (): void => {
  deprecationState.emitted.clear();
  deprecationState.enabled = true;
};
