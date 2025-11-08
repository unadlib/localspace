export {};

declare var __DEV__: boolean;

declare global {
  var webkitIndexedDB: Window['indexedDB'];
  var mozIndexedDB: Window['indexedDB'];
  var OIndexedDB: Window['indexedDB'];
  var msIndexedDB: Window['indexedDB'];
}
