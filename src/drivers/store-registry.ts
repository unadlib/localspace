// Prefix-based drivers persist the default store as `name/` and named stores
// as `name/storeName/`, so the default store's prefix also matches every named
// store. Named stores record themselves under a registry key outside every
// store prefix, letting scans exclude keys that belong to a registered store.
const STORE_REGISTRY_PREFIX = 'localspace:stores:';

export const getStoreRegistryKey = (name: string): string =>
  STORE_REGISTRY_PREFIX + name;

export const parseStoreRegistry = (raw: string | null): string[] => {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (store): store is string => typeof store === 'string' && !!store
        )
      : [];
  } catch {
    return [];
  }
};

export const createKeyOwnership = (
  name: string,
  keyPrefix: string,
  registeredStores: string[]
): ((fullKey: string) => boolean) => {
  const nestedPrefixes = registeredStores
    .map((store) => `${name}/${store}/`)
    .filter(
      (prefix) =>
        prefix.length > keyPrefix.length && prefix.indexOf(keyPrefix) === 0
    );
  return (fullKey) =>
    fullKey.indexOf(keyPrefix) === 0 &&
    !nestedPrefixes.some((prefix) => fullKey.indexOf(prefix) === 0);
};
