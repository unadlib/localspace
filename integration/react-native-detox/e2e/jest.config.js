module.exports = {
  maxWorkers: 1,
  testTimeout: 180000,
  testMatch: ['<rootDir>/**/*.e2e.js'],
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};
