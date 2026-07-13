export type LocalSpaceErrorCode =
  | 'CONFIG_LOCKED'
  | 'INVALID_CONFIG'
  | 'DRIVER_COMPLIANCE'
  | 'DRIVER_NOT_FOUND'
  | 'DRIVER_UNAVAILABLE'
  | 'DRIVER_NOT_INITIALIZED'
  | 'INSTANCE_CLOSED'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_ARGUMENT'
  | 'TRANSACTION_READONLY'
  | 'SERIALIZATION_FAILED'
  | 'DESERIALIZATION_FAILED'
  | 'BLOB_UNSUPPORTED'
  | 'OPERATION_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'UNKNOWN';

export type LocalSpaceErrorDetails = {
  driver?: string;
  operation?: string;
  key?: string;
  attemptedDrivers?: string[];
  configKey?: string;
  dbName?: string;
  storeName?: string;
  transactionMode?: string;
  causeName?: string;
  causeMessage?: string;
  driverErrors?: Array<{
    driver: string;
    name: string;
    message: string;
    code?: LocalSpaceErrorCode;
  }>;
  [key: string]: unknown;
};

export class LocalSpaceError extends Error {
  declare cause?: unknown;
  details?: LocalSpaceErrorDetails;
  code: LocalSpaceErrorCode;

  constructor(
    code: LocalSpaceErrorCode,
    message: string,
    details?: LocalSpaceErrorDetails,
    cause?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'LocalSpaceError';
    this.code = code;
    this.details = details;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  withDetails(details?: LocalSpaceErrorDetails): LocalSpaceError {
    if (!details) {
      return this;
    }
    this.details = { ...(this.details ?? {}), ...details };
    return this;
  }
}

export const describeError = (
  error: unknown
): { name: string; message: string } => {
  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown };
    if (
      typeof candidate.name === 'string' &&
      typeof candidate.message === 'string'
    ) {
      return {
        name: candidate.name,
        message: candidate.message,
      };
    }
  }

  const normalizedError =
    error instanceof Error ? error : new Error(String(error));
  return {
    name: normalizedError.name,
    message: normalizedError.message,
  };
};

export const createLocalSpaceError = (
  code: LocalSpaceErrorCode,
  message: string,
  details?: LocalSpaceErrorDetails
): LocalSpaceError => new LocalSpaceError(code, message, details);

export const toLocalSpaceError = (
  error: unknown,
  code: LocalSpaceErrorCode,
  message: string,
  details?: LocalSpaceErrorDetails
): LocalSpaceError => {
  if (error instanceof LocalSpaceError) {
    return details ? error.withDetails(details) : error;
  }

  const summary = describeError(error);
  const cause =
    error && (typeof error === 'object' || typeof error === 'function')
      ? error
      : new Error(summary.message);

  const enrichedDetails: LocalSpaceErrorDetails = {
    ...(details ?? {}),
    causeName: summary.name,
    causeMessage: summary.message,
  };

  const structuredError = new LocalSpaceError(
    code,
    message,
    enrichedDetails,
    cause
  );

  return structuredError;
};

export const wrapPromiseWithLocalSpaceError = <T>(
  promise: Promise<T>,
  code: LocalSpaceErrorCode,
  message: string,
  details?: LocalSpaceErrorDetails
): Promise<T> =>
  promise.catch((error) => {
    throw toLocalSpaceError(error, code, message, details);
  });
