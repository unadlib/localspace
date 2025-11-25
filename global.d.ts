export {};

declare var __DEV__: boolean;

declare global {
  var webkitIndexedDB: Window['indexedDB'];
  var mozIndexedDB: Window['indexedDB'];
  var OIndexedDB: Window['indexedDB'];
  var msIndexedDB: Window['indexedDB'];

  interface StorageBucketOptions {
    durability?: 'relaxed' | 'strict';
    persisted?: boolean;
  }

  interface StorageBucket {
    indexedDB: IDBFactory;
  }

  interface StorageBuckets {
    open(name: string, options?: StorageBucketOptions): Promise<StorageBucket>;
  }

  interface Navigator {
    storageBuckets?: StorageBuckets;
  }
}
