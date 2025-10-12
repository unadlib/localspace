/**
 * Basic usage examples for localspace
 * Demonstrates 100% API compatibility with localForage
 */

import localspace from '../src/index';

async function basicUsageExamples() {
  console.log('=== localspace Basic Usage Examples ===\n');

  // 1. Simple key-value storage
  console.log('1. Simple key-value storage:');
  await localspace.setItem('username', 'Alice');
  const username = await localspace.getItem('username');
  console.log('   Stored username:', username);

  // 2. Store complex objects
  console.log('\n2. Store complex objects:');
  const user = {
    id: 1,
    name: 'Bob',
    email: 'bob@example.com',
    preferences: {
      theme: 'dark',
      notifications: true
    }
  };
  await localspace.setItem('user', user);
  const retrievedUser = await localspace.getItem('user');
  console.log('   Retrieved user:', retrievedUser);

  // 3. Store arrays
  console.log('\n3. Store arrays:');
  const todos = ['Buy milk', 'Write code', 'Deploy app'];
  await localspace.setItem('todos', todos);
  const retrievedTodos = await localspace.getItem('todos');
  console.log('   Retrieved todos:', retrievedTodos);

  // 4. Get all keys
  console.log('\n4. Get all keys:');
  const keys = await localspace.keys();
  console.log('   All keys:', keys);

  // 5. Get length
  console.log('\n5. Get length:');
  const length = await localspace.length();
  console.log('   Number of items:', length);

  // 6. Iterate over items
  console.log('\n6. Iterate over items:');
  await localspace.iterate((value, key, iterationNumber) => {
    console.log(`   [${iterationNumber}] ${key}:`, value);
  });

  // 7. Remove an item
  console.log('\n7. Remove an item:');
  await localspace.removeItem('todos');
  console.log('   Removed "todos"');
  console.log('   Remaining keys:', await localspace.keys());

  // 8. Callback support (localForage compatibility)
  console.log('\n8. Callback support:');
  await new Promise<void>((resolve) => {
    localspace.getItem('username', (err, value) => {
      console.log('   Callback result:', value);
      resolve();
    });
  });

  // 9. Get current driver
  console.log('\n9. Get current driver:');
  const driver = localspace.driver();
  console.log('   Current driver:', driver);

  // 10. Check driver support
  console.log('\n10. Check driver support:');
  console.log('   Supports IndexedDB:', localspace.supports(localspace.INDEXEDDB));
  console.log('   Supports localStorage:', localspace.supports(localspace.LOCALSTORAGE));

  // 11. Configuration
  console.log('\n11. Configuration:');
  const config = localspace.config();
  console.log('   Database name:', config.name);
  console.log('   Store name:', config.storeName);
  console.log('   Version:', config.version);

  // 12. Create isolated instance
  console.log('\n12. Create isolated instance:');
  const cache = localspace.createInstance({
    name: 'myCache',
    storeName: 'items'
  });
  await cache.setItem('cached-data', { timestamp: Date.now() });
  const cachedData = await cache.getItem('cached-data');
  console.log('   Cached data:', cachedData);

  // 13. Store binary data (ArrayBuffer)
  console.log('\n13. Store binary data:');
  const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  await localspace.setItem('binary-data', buffer);
  const retrievedBuffer = await localspace.getItem('binary-data');
  console.log('   Buffer length:', (retrievedBuffer as ArrayBuffer)?.byteLength);

  // 14. Store TypedArray
  console.log('\n14. Store TypedArray:');
  const typedArray = new Float32Array([1.1, 2.2, 3.3]);
  await localspace.setItem('float-array', typedArray);
  const retrievedArray = await localspace.getItem('float-array');
  console.log('   TypedArray:', retrievedArray);

  // 15. Clear all data
  console.log('\n15. Clear all data:');
  await localspace.clear();
  console.log('   Storage cleared');
  console.log('   Length after clear:', await localspace.length());

  console.log('\n=== Examples Complete ===');
}

// Run examples
basicUsageExamples().catch(console.error);
