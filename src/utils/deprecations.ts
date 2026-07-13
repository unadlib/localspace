export type LocalSpaceDeprecation =
  | 'legacy-encryption-algorithm'
  | 'legacy-size-option'
  | 'destroy'
  | 'mutable-config-reference'
  | 'combined-plugin-hooks'
  | 'react-native-auto-detection';

const emittedDeprecations = new Set<LocalSpaceDeprecation>();
let deprecationWarningsEnabled = true;

const isProductionRuntime = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production';

/**
 * Enable or disable development-only deprecation warnings globally for the
 * current copy of localspace.
 */
export const setDeprecationWarnings = (enabled: boolean): void => {
  deprecationWarningsEnabled = enabled;
};

export const warnDeprecation = (
  deprecation: LocalSpaceDeprecation,
  message: string
): void => {
  if (
    !deprecationWarningsEnabled ||
    isProductionRuntime() ||
    emittedDeprecations.has(deprecation)
  ) {
    return;
  }

  emittedDeprecations.add(deprecation);
  console.warn(`[localspace] Deprecation: ${message}`);
};

export const resetDeprecationWarningsForTests = (): void => {
  emittedDeprecations.clear();
  deprecationWarningsEnabled = true;
};
