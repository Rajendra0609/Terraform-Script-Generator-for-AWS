// tests/jest.api.config.js
'use strict';
const base = require('./jest.config');

module.exports = {
  ...base,
  displayName: 'API',
  testMatch:   ['<rootDir>/api/**/*.test.js'],
  testTimeout: 45000,
};
