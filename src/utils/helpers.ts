import type {
  Callback,
  CompatibilityErrorCallback,
  CompatibilitySuccessCallback,
} from '../types';

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
      (error) => callback(error, undefined)
    );
  }
  return promise;
}

/**
 * Execute two callbacks (success and error)
 */
export function executeTwoCallbacks<T>(
  promise: Promise<T>,
  callback?: Callback<T> | CompatibilitySuccessCallback<T>,
  errorCallback?:
    | ((error: Error) => void)
    | CompatibilityErrorCallback
    | Callback<T>,
  options?: { compatibilityMode?: boolean }
): Promise<T> {
  const normalizeError = (error: unknown): Error => {
    return error instanceof Error ? error : new Error(String(error));
  };

  if (options?.compatibilityMode) {
    if (typeof callback === 'function') {
      promise.then((result) => {
        (callback as CompatibilitySuccessCallback<T>)(result);
      });
    }

    if (typeof errorCallback === 'function') {
      promise.catch((error) => {
        (errorCallback as CompatibilityErrorCallback)(normalizeError(error));
      });
    }

    return promise;
  }

  const handleError = (error: unknown) => {
    const normalizedError = normalizeError(error);

    if (errorCallback) {
      (errorCallback as (error: Error) => void)(normalizedError);
    } else if (callback) {
      (callback as Callback<T>)(normalizedError, undefined);
    }
  };

  if (callback) {
    promise.then(
      (result) => (callback as Callback<T>)(null, result),
      handleError
    );
  } else if (errorCallback) {
    promise.catch(handleError);
  }

  return promise;
}

/**
 * Get callback from arguments (handles optional parameters)
 */
export function getCallback<T extends unknown[]>(
  args: T
): Callback | undefined {
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
export function isArray<T>(value: T | T[]): value is T[] {
  return Array.isArray(value);
}

/**
 * Normalize key (convert to string)
 */
export function normalizeKey(key: unknown): string {
  if (typeof key !== 'string') {
    console.warn(
      `key passed to LocalSpace API is not a string (got ${typeof key}). Using String() to convert.`
    );
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
      throw new Error('Blob constructor not supported');
    }

    const builder = new BlobBuilder();
    for (const part of parts) {
      builder.append(part);
    }
    return builder.getBlob(properties?.type);
  }
}
