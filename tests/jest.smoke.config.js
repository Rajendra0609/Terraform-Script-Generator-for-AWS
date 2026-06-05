// tests/jest.smoke.config.js
'use strict';
const base = require('./jest.config');

module.exports = {
  ...base,
  displayName:    'SMOKE',
  testMatch:      ['<rootDir>/smoke/**/*.test.js'],
  testTimeout:    15000,
  globalSetup:    undefined,
  globalTeardown: undefined,
};
