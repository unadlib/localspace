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

const hasOwn = (value: object, property: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, property);

export const readPluginEnvelope = <T>(
  value: unknown,
  expectedKind: PluginEnvelopeKind
): PluginEnvelopeReadResult<T> => {
  if (!value || typeof value !== 'object') {
    return { matched: false };
  }

  const record = value as Record<string, unknown>;
  if (!hasOwn(record, PLUGIN_ENVELOPE_PROPERTY)) {
    return { matched: false };
  }

  const header = record[PLUGIN_ENVELOPE_PROPERTY];
  if (!header || typeof header !== 'object') {
    return { matched: false };
  }

  const headerRecord = header as Record<string, unknown>;
  if (headerRecord.namespace !== PLUGIN_ENVELOPE_NAMESPACE) {
    return { matched: false };
  }
  if (headerRecord.kind !== expectedKind) {
    return { matched: false };
  }

  if (headerRecord.version !== PLUGIN_ENVELOPE_VERSION) {
    throw createLocalSpaceError(
      'DESERIALIZATION_FAILED',
      `Unsupported ${expectedKind} plugin envelope version.`,
      {
        payloadKind: expectedKind,
        payloadVersion: headerRecord.version,
        supportedPayloadVersions: [PLUGIN_ENVELOPE_VERSION],
      }
    );
  }
  if (!hasOwn(record, 'payload')) {
    throw createLocalSpaceError(
      'DESERIALIZATION_FAILED',
      `Invalid ${expectedKind} plugin envelope: missing payload.`,
      {
        payloadKind: expectedKind,
        payloadVersion: PLUGIN_ENVELOPE_VERSION,
      }
    );
  }

  return { matched: true, payload: record.payload as T };
};

export const hasOwnPayloadField = (
  value: object,
  property: PropertyKey
): boolean => hasOwn(value, property);
