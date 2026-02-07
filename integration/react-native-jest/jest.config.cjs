/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['**/*.test.cjs'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  clearMocks: true,
  restoreMocks: true,
};
