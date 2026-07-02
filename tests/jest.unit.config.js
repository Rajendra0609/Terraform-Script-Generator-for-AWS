// tests/jest.unit.config.js
'use strict';
const base = require('./jest.config');

module.exports = {
  ...base,
  displayName:  'UNIT',
  testMatch:    ['<rootDir>/unit/**/*.test.js'],
  // Unit tests never touch the DB — no globalSetup overhead needed
  globalSetup:    undefined,
  globalTeardown: undefined,
};
