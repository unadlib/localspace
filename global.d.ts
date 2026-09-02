export {};

declare global {
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
