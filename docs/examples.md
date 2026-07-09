# Real-World Examples

Comprehensive examples demonstrating plugin usage in production scenarios.

## Table of Contents

- [E-commerce Shopping Cart](#e-commerce-shopping-cart)
- [Secure User Credentials Storage](#secure-user-credentials-storage)
- [Offline-First Application Cache](#offline-first-application-cache)

---

## E-commerce Shopping Cart

Persistent cart with TTL expiration:

```ts
import localspace, { ttlPlugin } from 'localspace';

// Create cart storage with expiration
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
import localspace, { ttlPlugin, compressionPlugin } from 'localspace';

const apiCache = localspace.createInstance({
  name: 'offline-app',
  storeName: 'api-cache',
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
