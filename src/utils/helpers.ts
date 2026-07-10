import type { BatchItems, KeyValuePair } from '../types.js';
import { createLocalSpaceError } from '../errors.js';

/**
 * Check if value is in array
 */
export function includes<T>(arr: T[], value: T): boolean {
  return arr.indexOf(value) !== -1;
}

/**
 * Check if value is array
 */
export function isArray<T>(value: T | T[]): value is T[] {
  return Array.isArray(value);
}

/**
 * Normalize key (convert to string)
 */
const warnedNonStringKeyTypes = new Set<string>();

export function normalizeKey(key: unknown): string {
  if (typeof key !== 'string') {
    const keyType = typeof key;
    // Warn once per offending type; batch/loop misuse should not flood the console.
    if (!warnedNonStringKeyTypes.has(keyType)) {
      warnedNonStringKeyTypes.add(keyType);
      console.warn(
        `key passed to LocalSpace API is not a string (got ${keyType}). Using String() to convert. Further ${keyType} keys are converted silently.`
      );
    }
    return String(key);
  }
  return key;
}

/**
 * Extend object (shallow merge)
 */
export function extend<T extends object>(
  target: T,
  ...sources: Partial<T>[]
): T {
  const targetRecord = target as Record<string, unknown>;
  for (const source of sources) {
    if (source) {
      const sourceRecord = source as Record<string, unknown>;
      for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const value = sourceRecord[key];
          targetRecord[key] = isArray(value) ? [...value] : value;
        }
      }
    }
  }
  return target;
}

/**
 * Create a Blob (with fallback for older browsers)
 */
type LegacyBlobBuilderConstructor = {
  new (): {
    append(part: BlobPart): void;
    getBlob(type?: string): Blob;
  };
};

export function createBlob(
  parts: BlobPart[],
  properties?: BlobPropertyBag
): Blob {
  try {
    return new Blob(parts, properties);
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.name !== 'TypeError') {
      throw error;
    }
    // Fallback for older browsers (though we're targeting modern ones)
    const legacyWindow = window as typeof window & {
      BlobBuilder?: LegacyBlobBuilderConstructor;
      MSBlobBuilder?: LegacyBlobBuilderConstructor;
      MozBlobBuilder?: LegacyBlobBuilderConstructor;
      WebKitBlobBuilder?: LegacyBlobBuilderConstructor;
    };

    const BlobBuilder =
      legacyWindow.BlobBuilder ||
      legacyWindow.MSBlobBuilder ||
      legacyWindow.MozBlobBuilder ||
      legacyWindow.WebKitBlobBuilder;

    if (!BlobBuilder) {
      throw createLocalSpaceError(
        'BLOB_UNSUPPORTED',
        'Blob constructor not supported'
      );
    }

    const builder = new BlobBuilder();
    for (const part of parts) {
      builder.append(part);
    }
    return builder.getBlob(properties?.type);
  }
}

/**
 * Normalize batch inputs (array/map/object) into a flat list of key/value pairs
 */
export function normalizeBatchEntries<T>(
  items: BatchItems<T>
): KeyValuePair<T>[] {
  if (Array.isArray(items)) {
    return items.map(({ key, value }) => ({ key: normalizeKey(key), value }));
  }

  if (items instanceof Map) {
    const normalized: KeyValuePair<T>[] = [];
    items.forEach((value, key) => {
      normalized.push({ key: normalizeKey(key), value });
    });
    return normalized;
  }

  const normalized: KeyValuePair<T>[] = [];
  for (const key of Object.keys(items)) {
    normalized.push({ key: normalizeKey(key), value: items[key] });
  }
  return normalized;
}

/**
 * Split an array into chunks respecting the provided size.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0 || size >= items.length) {
    return [items];
  }

  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
