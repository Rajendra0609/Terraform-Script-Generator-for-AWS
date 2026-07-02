// tests/jest.security.config.js
'use strict';
const base = require('./jest.config');

module.exports = {
  ...base,
  displayName: 'SECURITY',
  testMatch:   ['<rootDir>/performance/security.test.js'],
  testTimeout: 60000,
};
