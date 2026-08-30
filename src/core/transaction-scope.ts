import type { TransactionScope } from '../types.js';

const RUN_TRANSACTION_SCOPE_OPERATION = Symbol(
  'localspace.internal.run-transaction-scope-operation'
);

export type DriverTransactionScope = TransactionScope & {
  [RUN_TRANSACTION_SCOPE_OPERATION]?<T>(
    scopeOperation: keyof TransactionScope,
    operation: () => Promise<T> | T
  ): Promise<T>;
};

export const markDriverTransactionScope = (
  scope: TransactionScope,
  runOperation: <T>(
    scopeOperation: keyof TransactionScope,
    operation: () => Promise<T> | T
  ) => Promise<T>
): TransactionScope => {
  Object.defineProperty(scope, RUN_TRANSACTION_SCOPE_OPERATION, {
    value: runOperation,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return scope;
};

export const runDriverTransactionScopeOperation = <T>(
  scope: TransactionScope,
  scopeOperation: keyof TransactionScope,
  operation: () => Promise<T> | T
): Promise<T> => {
  const runOperation = (scope as DriverTransactionScope)[
    RUN_TRANSACTION_SCOPE_OPERATION
  ];
  return runOperation
    ? runOperation(scopeOperation, operation)
    : Promise.resolve().then(operation);
};
