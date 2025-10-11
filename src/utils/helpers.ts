import type { Callback } from '../types';

/**
 * Execute callback if provided, handling errors gracefully
 */
export function executeCallback<T>(
  promise: Promise<T>,
  callback?: Callback<T>
): Promise<T> {
  if (callback) {
    promise.then(
      (result) => callback(null, result),
      (error) => callback(error)
    );
  }
  return promise;
}

/**
 * Execute two callbacks (success and error)
 */
export function executeTwoCallbacks<T>(
  promise: Promise<T>,
  successCallback?: Callback<T>,
  errorCallback?: Callback<Error>
): Promise<T> {
  if (successCallback) {
    promise.then(
      (result) => successCallback(null, result),
      errorCallback || successCallback
    );
  } else if (errorCallback) {
    promise.catch(errorCallback);
  }
  return promise;
}

/**
 * Get callback from arguments (handles optional parameters)
 */
export function getCallback<T extends any[]>(args: T): Callback | undefined {
  if (args.length > 0 && typeof args[args.length - 1] === 'function') {
    return args[args.length - 1] as Callback;
  }
  return undefined;
}

/**
 * Check if value is in array
 */
export function includes<T>(arr: T[], value: T): boolean {
  return arr.indexOf(value) !== -1;
}

/**
 * Check if value is array
 */
export function isArray(value: any): value is any[] {
  return Array.isArray(value);
}

/**
 * Normalize key (convert to string)
 */
export function normalizeKey(key: any): string {
  // localForage behavior: cast keys to strings
  if (typeof key !== 'string') {
    console.warn(
      `key passed to localForage API is not a string (got ${typeof key}). Using String() to convert.`
    );
    return String(key);
  }
  return key;
}

/**
 * Extend object (shallow merge)
 */
export function extend<T extends object>(target: T, ...sources: Partial<T>[]): T {
  for (const source of sources) {
    if (source) {
      for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const value = source[key];
          if (isArray(value)) {
            (target as any)[key] = (value as any).slice();
          } else {
            (target as any)[key] = value;
          }
        }
      }
    }
  }
  return target;
}

/**
 * Create a Blob (with fallback for older browsers)
 */
export function createBlob(parts: BlobPart[], properties?: BlobPropertyBag): Blob {
  try {
    return new Blob(parts, properties);
  } catch (e: any) {
    if (e.name !== 'TypeError') {
      throw e;
    }
    // Fallback for older browsers (though we're targeting modern ones)
    const BlobBuilder =
      (window as any).BlobBuilder ||
      (window as any).MSBlobBuilder ||
      (window as any).MozBlobBuilder ||
      (window as any).WebKitBlobBuilder;

    if (!BlobBuilder) {
      throw new Error('Blob constructor not supported');
    }

    const builder = new BlobBuilder();
    for (const part of parts) {
      builder.append(part);
    }
    return builder.getBlob(properties?.type);
  }
}
