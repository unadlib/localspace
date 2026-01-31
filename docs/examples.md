# Real-World Examples

Comprehensive examples demonstrating plugin usage in production scenarios.

## Table of Contents

- [E-commerce Shopping Cart](#e-commerce-shopping-cart)
- [Secure User Credentials Storage](#secure-user-credentials-storage)
- [Offline-First Application Cache](#offline-first-application-cache)
- [Multi-Tab Collaborative Editor](#multi-tab-collaborative-editor)
- [Mobile App with Limited Storage](#mobile-app-with-limited-storage)

---

## E-commerce Shopping Cart

Multi-tab synchronized cart with TTL expiration and quota management:

```ts
import localspace, { ttlPlugin, syncPlugin, quotaPlugin } from 'localspace';

// Create cart storage with sync and expiration
const cartStore = localspace.createInstance({
  name: 'ecommerce',
  storeName: 'cart',
  plugins: [
    // Cart items expire after 7 days
    ttlPlugin({
      defaultTTL: 7 * 24 * 60 * 60 * 1000, // 7 days
      cleanupInterval: 60 * 60 * 1000, // Hourly cleanup
      onExpire: (key, value) => {
        analytics.track('cart_expired', {
          key,
          itemCount: value?.items?.length,
        });
      },
    }),

    // Sync cart across browser tabs
    syncPlugin({
      channelName: 'cart-sync',
      syncKeys: ['cart', 'wishlist', 'recently-viewed'],
      onConflict: ({ key, localTimestamp, incomingTimestamp, value }) => {
        // Accept newer cart, merge for wishlist
        if (key === 'wishlist') {
          // Merge logic handled in application layer
          return true;
        }
        return incomingTimestamp > localTimestamp;
      },
    }),

    // Limit cart storage to 1MB
    quotaPlugin({
      maxSize: 1 * 1024 * 1024,
      evictionPolicy: 'error', // Don't auto-delete cart items
      onQuotaExceeded: ({ attemptedSize, currentUsage, maxSize }) => {
        showToast('Cart is too large. Please remove some items.');
      },
    }),
  ],
  pluginErrorPolicy: 'strict',
});

// Cart operations
class CartService {
  async addItem(productId: string, quantity: number) {
    const cart = (await cartStore.getItem<Cart>('cart')) ?? { items: [] };
    const existing = cart.items.find((i) => i.productId === productId);

    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.items.push({ productId, quantity, addedAt: Date.now() });
    }

    cart.updatedAt = Date.now();
    await cartStore.setItem('cart', cart);
    return cart;
  }

  async removeItem(productId: string) {
    const cart = await cartStore.getItem<Cart>('cart');
    if (!cart) return null;

    cart.items = cart.items.filter((i) => i.productId !== productId);
    cart.updatedAt = Date.now();
    await cartStore.setItem('cart', cart);
    return cart;
  }

  async getCart(): Promise<Cart | null> {
    return cartStore.getItem('cart');
  }

  async clearCart() {
    await cartStore.removeItem('cart');
  }
}

interface Cart {
  items: CartItem[];
  updatedAt: number;
}

interface CartItem {
  productId: string;
  quantity: number;
  addedAt: number;
}
```

---

## Secure User Credentials Storage

Encrypted storage for sensitive user data with key derivation:

```ts
import localspace, { encryptionPlugin, ttlPlugin } from 'localspace';

// Create secure credentials store
async function createSecureStore(userPassword: string, userId: string) {
  const store = localspace.createInstance({
    name: 'secure-vault',
    storeName: 'credentials',
    plugins: [
      // Short TTL for security-sensitive data
      ttlPlugin({
        defaultTTL: 30 * 60 * 1000, // 30 minutes default
        keyTTL: {
          'session-token': 4 * 60 * 60 * 1000, // 4 hours for session
          'refresh-token': 7 * 24 * 60 * 60 * 1000, // 7 days for refresh
          'biometric-key': 24 * 60 * 60 * 1000, // 24 hours for biometrics
        },
        onExpire: async (key) => {
          if (key === 'session-token') {
            // Trigger re-authentication
            window.dispatchEvent(new CustomEvent('session-expired'));
          }
        },
      }),

      // Encrypt with password-derived key
      encryptionPlugin({
        keyDerivation: {
          passphrase: userPassword,
          salt: `vault-salt-${userId}`, // User-specific salt
          iterations: 200000, // High iteration count for security
          hash: 'SHA-256',
          length: 256,
        },
      }),
    ],
    pluginErrorPolicy: 'strict', // Never swallow encryption errors
  });

  await store.ready();
  return store;
}

// Usage example
class CredentialManager {
  private store: Awaited<ReturnType<typeof createSecureStore>> | null = null;

  async initialize(password: string, userId: string) {
    this.store = await createSecureStore(password, userId);
  }

  async storeCredentials(credentials: {
    accessToken: string;
    refreshToken: string;
    apiKeys?: Record<string, string>;
  }) {
    if (!this.store) throw new Error('Store not initialized');

    await this.store.setItems([
      { key: 'session-token', value: credentials.accessToken },
      { key: 'refresh-token', value: credentials.refreshToken },
      ...(credentials.apiKeys
        ? Object.entries(credentials.apiKeys).map(([name, key]) => ({
            key: `api-key:${name}`,
            value: key,
          }))
        : []),
    ]);
  }

  async getAccessToken(): Promise<string | null> {
    return this.store?.getItem('session-token') ?? null;
  }

  async getApiKey(name: string): Promise<string | null> {
    return this.store?.getItem(`api-key:${name}`) ?? null;
  }

  async logout() {
    if (this.store) {
      await this.store.clear();
      await this.store.destroy();
      this.store = null;
    }
  }
}
```

---

## Offline-First Application Cache

Compressed API cache with intelligent expiration:

```ts
import localspace, {
  ttlPlugin,
  compressionPlugin,
  quotaPlugin,
} from 'localspace';

const apiCache = localspace.createInstance({
  name: 'offline-app',
  storeName: 'api-cache',
  coalesceWrites: true, // Batch rapid cache updates
  coalesceWindowMs: 16,
  plugins: [
    // Different TTLs for different data types
    ttlPlugin({
      defaultTTL: 5 * 60 * 1000, // 5 minutes for general API data
      keyTTL: {
        'static:*': 24 * 60 * 60 * 1000, // 24 hours for static content
        'user:profile': 30 * 60 * 1000, // 30 minutes for user data
        'feed:*': 2 * 60 * 1000, // 2 minutes for feeds
      },
      cleanupInterval: 5 * 60 * 1000, // Cleanup every 5 minutes
      cleanupBatchSize: 200,
    }),

    // Compress large responses
    compressionPlugin({
      threshold: 2048, // Compress responses > 2KB
      algorithm: 'lz-string',
    }),

    // Manage cache size (50MB limit)
    quotaPlugin({
      maxSize: 50 * 1024 * 1024,
      evictionPolicy: 'lru', // Auto-evict old cached items
      onQuotaExceeded: ({ key }) => {
        console.log(`Evicted cache entry: ${key}`);
      },
    }),
  ],
});

// Cache-aware fetch wrapper
async function cachedFetch<T>(
  url: string,
  options?: {
    cacheKey?: string;
    ttl?: number;
    skipCache?: boolean;
  }
): Promise<T> {
  const cacheKey = options?.cacheKey ?? `api:${url}`;

  // Check cache first
  if (!options?.skipCache) {
    const cached = await apiCache.getItem<CachedResponse<T>>(cacheKey);
    if (cached) {
      // Return cached data, optionally revalidate in background
      if (cached.staleAt && Date.now() > cached.staleAt) {
        // Stale-while-revalidate pattern
        revalidateInBackground(url, cacheKey);
      }
      return cached.data;
    }
  }

  // Fetch fresh data
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as T;

  // Cache the response
  await apiCache.setItem(cacheKey, {
    data,
    fetchedAt: Date.now(),
    staleAt: Date.now() + (options?.ttl ?? 60_000), // Stale after 1 minute
  });

  return data;
}

async function revalidateInBackground(url: string, cacheKey: string) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      await apiCache.setItem(cacheKey, {
        data,
        fetchedAt: Date.now(),
        staleAt: Date.now() + 60_000,
      });
    }
  } catch {
    // Silent failure for background revalidation
  }
}

interface CachedResponse<T> {
  data: T;
  fetchedAt: number;
  staleAt?: number;
}

// Prefetch common data
async function prefetchAppData() {
  const prefetchUrls = [
    '/api/user/profile',
    '/api/settings',
    '/api/notifications/count',
  ];

  await Promise.all(
    prefetchUrls.map((url) => cachedFetch(url).catch(() => null))
  );
}

// Clear cache on logout
async function clearCacheOnLogout() {
  await apiCache.clear();
}
```

---

## Multi-Tab Collaborative Editor

Real-time document sync with conflict resolution:

```ts
import localspace, { syncPlugin, ttlPlugin } from 'localspace';

interface Document {
  id: string;
  content: string;
  version: number;
  lastModified: number;
  author: string;
}

interface SyncState {
  localVersion: number;
  pendingChanges: Change[];
}

interface Change {
  type: 'insert' | 'delete';
  position: number;
  text?: string;
  length?: number;
  timestamp: number;
}

const editorStore = localspace.createInstance({
  name: 'collaborative-editor',
  storeName: 'documents',
  plugins: [
    // Auto-save draft recovery
    ttlPlugin({
      keyTTL: {
        'draft:*': 7 * 24 * 60 * 60 * 1000, // Drafts expire after 7 days
        'sync-state:*': 24 * 60 * 60 * 1000, // Sync state expires after 24 hours
      },
    }),

    // Sync edits across tabs
    syncPlugin({
      channelName: 'editor-sync',
      conflictStrategy: 'custom',
      onConflict: ({
        key,
        value: incoming,
        localTimestamp,
        incomingTimestamp,
      }) => {
        if (!key.startsWith('doc:')) return true;

        const incomingDoc = incoming as Document;
        // Version-based conflict resolution
        // Higher version always wins
        return incomingDoc.version > localTimestamp;
      },
    }),
  ],
});

// Real-time collaborative editing service
class CollaborativeEditor {
  private documentId: string;
  private localChanges: Change[] = [];
  private onRemoteChange?: (doc: Document) => void;

  constructor(documentId: string) {
    this.documentId = documentId;
    this.setupSyncListener();
  }

  private setupSyncListener() {
    // Listen for remote changes via storage event or broadcast
    window.addEventListener('storage', async (e) => {
      if (e.key?.includes(`doc:${this.documentId}`)) {
        const doc = await editorStore.getItem<Document>(
          `doc:${this.documentId}`
        );
        if (doc) {
          this.onRemoteChange?.(doc);
        }
      }
    });
  }

  async loadDocument(): Promise<Document | null> {
    return editorStore.getItem(`doc:${this.documentId}`);
  }

  async saveDocument(content: string, author: string): Promise<Document> {
    const existing = await this.loadDocument();
    const doc: Document = {
      id: this.documentId,
      content,
      version: (existing?.version ?? 0) + 1,
      lastModified: Date.now(),
      author,
    };

    await editorStore.setItem(`doc:${this.documentId}`, doc);

    // Also save draft for recovery
    await editorStore.setItem(`draft:${this.documentId}`, {
      content,
      savedAt: Date.now(),
    });

    return doc;
  }

  async saveDraft(content: string) {
    await editorStore.setItem(`draft:${this.documentId}`, {
      content,
      savedAt: Date.now(),
    });
  }

  async recoverDraft(): Promise<string | null> {
    const draft = await editorStore.getItem<{
      content: string;
      savedAt: number;
    }>(`draft:${this.documentId}`);
    return draft?.content ?? null;
  }

  onRemoteUpdate(callback: (doc: Document) => void) {
    this.onRemoteChange = callback;
  }

  async getRecentDocuments(limit = 10): Promise<Document[]> {
    const docs: Document[] = [];
    await editorStore.iterate<Document, void>((value, key) => {
      if (key.startsWith('doc:') && value) {
        docs.push(value);
      }
    });
    return docs.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  }
}
```

---

## Mobile App with Limited Storage

Progressive quota management for mobile-first apps:

```ts
import localspace, {
  ttlPlugin,
  compressionPlugin,
  quotaPlugin,
} from 'localspace';

// Detect if running on mobile
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const storageLimit = isMobile ? 10 * 1024 * 1024 : 50 * 1024 * 1024; // 10MB mobile, 50MB desktop

const mobileStore = localspace.createInstance({
  name: 'mobile-app',
  storeName: 'data',
  plugins: [
    // Aggressive TTL for mobile
    ttlPlugin({
      defaultTTL: isMobile ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000, // 2h mobile, 24h desktop
      cleanupInterval: isMobile ? 10 * 60 * 1000 : 60 * 60 * 1000, // 10min mobile, 1h desktop
      cleanupBatchSize: isMobile ? 50 : 200,
      onExpire: (key) => {
        console.debug(`[Storage] Expired: ${key}`);
      },
    }),

    // Compress everything on mobile
    compressionPlugin({
      threshold: isMobile ? 512 : 2048, // Lower threshold on mobile
    }),

    // Strict quota management
    quotaPlugin({
      maxSize: storageLimit,
      evictionPolicy: 'lru',
      useNavigatorEstimate: true, // Also respect browser limits
      onQuotaExceeded: async ({
        key,
        attemptedSize,
        currentUsage,
        maxSize,
      }) => {
        const usage = Math.round((currentUsage / maxSize) * 100);
        console.warn(`[Storage] Quota ${usage}% used, evicting old data`);

        // Show user notification on mobile
        if (isMobile && usage > 90) {
          showStorageWarning();
        }
      },
    }),
  ],
});

// Priority-based storage with automatic cleanup
type Priority = 'critical' | 'high' | 'normal' | 'low';

const priorityTTL: Record<Priority, number> = {
  critical: Infinity, // Never auto-expire
  high: 7 * 24 * 60 * 60 * 1000,
  normal: 24 * 60 * 60 * 1000,
  low: 2 * 60 * 60 * 1000,
};

async function storeWithPriority<T>(
  key: string,
  value: T,
  priority: Priority = 'normal'
) {
  const wrapper = {
    data: value,
    priority,
    storedAt: Date.now(),
  };
  await mobileStore.setItem(key, wrapper);
}

async function getStorageStats() {
  let totalItems = 0;
  let byPriority: Record<Priority, number> = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };

  await mobileStore.iterate<{ priority?: Priority }, void>((value) => {
    totalItems++;
    if (value?.priority) {
      byPriority[value.priority]++;
    }
  });

  return { totalItems, byPriority };
}

// Manual cleanup for low-priority items
async function freeUpSpace(targetBytes: number) {
  const keysToRemove: string[] = [];
  let freedBytes = 0;

  // First, remove low-priority items
  await mobileStore.iterate<{ priority?: Priority; data: unknown }, void>(
    (value, key) => {
      if (value?.priority === 'low') {
        keysToRemove.push(key);
        freedBytes += JSON.stringify(value).length;
        if (freedBytes >= targetBytes) {
          return true; // Stop iteration
        }
      }
    }
  );

  if (keysToRemove.length > 0) {
    await mobileStore.removeItems(keysToRemove);
  }

  return { removed: keysToRemove.length, freedBytes };
}

function showStorageWarning() {
  // Show toast or modal to user
  console.warn('Storage is almost full. Some cached data may be removed.');
}
```
