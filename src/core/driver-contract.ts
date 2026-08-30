export const REQUIRED_DRIVER_OPERATIONS = [
  'clear',
  'getItem',
  'iterate',
  'key',
  'keys',
  'length',
  'removeItem',
  'setItem',
] as const;

export const OPTIONAL_DRIVER_OPERATIONS = [
  'dropInstance',
  'getItems',
  'removeItems',
  'runTransaction',
  'setItems',
] as const;

export const DRIVER_OPERATIONS = [
  ...REQUIRED_DRIVER_OPERATIONS,
  ...OPTIONAL_DRIVER_OPERATIONS,
] as const;

export type DriverOperation = (typeof DRIVER_OPERATIONS)[number];
