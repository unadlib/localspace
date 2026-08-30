import { createLocalSpaceError } from '../errors.js';

export const PLUGIN_ENVELOPE_PROPERTY = '__localspace__' as const;
export const PLUGIN_ENVELOPE_NAMESPACE = 'localspace.plugin' as const;
export const PLUGIN_ENVELOPE_VERSION = 1 as const;

export type PluginEnvelopeKind = 'encryption' | 'compression' | 'ttl';

export type PluginEnvelopeV1<T = unknown> = {
  [PLUGIN_ENVELOPE_PROPERTY]: {
    namespace: typeof PLUGIN_ENVELOPE_NAMESPACE;
    kind: PluginEnvelopeKind;
    version: typeof PLUGIN_ENVELOPE_VERSION;
  };
  payload: T;
};

export type PluginEnvelopeReadResult<T> =
  | { matched: false }
  | { matched: true; payload: T };

export const createPluginEnvelope = <T>(
  kind: PluginEnvelopeKind,
  payload: T
): PluginEnvelopeV1<T> => ({
  [PLUGIN_ENVELOPE_PROPERTY]: {
    namespace: PLUGIN_ENVELOPE_NAMESPACE,
    kind,
    version: PLUGIN_ENVELOPE_VERSION,
  },
  payload,
});

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ownDataDescriptor = (
  value: object,
  property: PropertyKey
): PropertyDescriptor | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor && 'value' in descriptor ? descriptor : undefined;
};

export const hasExactPayloadFields = (
  value: unknown,
  expected: readonly string[]
): value is Record<string, unknown> => {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    return false;
  }
  return expected.every((key) => !!ownDataDescriptor(value, key)?.enumerable);
};

export const readOwnPayloadField = (
  value: object,
  property: PropertyKey
): unknown => ownDataDescriptor(value, property)?.value;

const invalidEnvelope = (
  kind: PluginEnvelopeKind,
  reason: string
): never => {
  throw createLocalSpaceError(
    'DESERIALIZATION_FAILED',
    `Invalid ${kind} plugin envelope: ${reason}.`,
    {
      payloadKind: kind,
      payloadVersion: PLUGIN_ENVELOPE_VERSION,
      reason,
    }
  );
};

export const readPluginEnvelope = <T>(
  value: unknown,
  expectedKind: PluginEnvelopeKind
): PluginEnvelopeReadResult<T> => {
  if (!isRecord(value)) {
    return { matched: false };
  }

  const record = value;
  const headerDescriptor = ownDataDescriptor(
    record,
    PLUGIN_ENVELOPE_PROPERTY
  );
  if (!headerDescriptor || !isRecord(headerDescriptor.value)) {
    return { matched: false };
  }

  const headerRecord = headerDescriptor.value;
  if (
    readOwnPayloadField(headerRecord, 'namespace') !==
    PLUGIN_ENVELOPE_NAMESPACE
  ) {
    return { matched: false };
  }
  if (readOwnPayloadField(headerRecord, 'kind') !== expectedKind) {
    return { matched: false };
  }

  const version = readOwnPayloadField(headerRecord, 'version');
  if (version !== PLUGIN_ENVELOPE_VERSION) {
    throw createLocalSpaceError(
      'DESERIALIZATION_FAILED',
      `Unsupported ${expectedKind} plugin envelope version.`,
      {
        payloadKind: expectedKind,
        payloadVersion: version,
        supportedPayloadVersions: [PLUGIN_ENVELOPE_VERSION],
      }
    );
  }
  if (
    !hasExactPayloadFields(record, [PLUGIN_ENVELOPE_PROPERTY, 'payload']) ||
    !hasExactPayloadFields(headerRecord, ['namespace', 'kind', 'version'])
  ) {
    return invalidEnvelope(expectedKind, 'invalid envelope shape');
  }

  return {
    matched: true,
    payload: readOwnPayloadField(record, 'payload') as T,
  };
};

export const hasOwnPayloadField = (
  value: object,
  property: PropertyKey
): boolean => !!ownDataDescriptor(value, property)?.enumerable;
