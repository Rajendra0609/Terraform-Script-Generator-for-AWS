// tests/jest.integration.config.js
'use strict';
const base = require('./jest.config');

module.exports = {
  ...base,
  displayName: 'INTEGRATION',
  testMatch:   ['<rootDir>/integration/**/*.test.js'],
  testTimeout: 60000,   // DB setup can be slow
};
