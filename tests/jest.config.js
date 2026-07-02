// tests/jest.config.js  — base shared config (extended by the per-suite configs)
'use strict';

module.exports = {
  testEnvironment: 'node',
  testTimeout:     30000,
  verbose:         true,
  // JUnit XML output for Jenkins' built-in test results view
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: './reports',
      outputName:      'junit-results.xml',
      classNameTemplate: '{classname}',
      titleTemplate:     '{title}',
      ancestorSeparator: ' › ',
    }],
  ],
  // Global setup / teardown
  globalSetup:    './setup/globalSetup.js',
  globalTeardown: './setup/globalTeardown.js',
  // Coverage (toggled with --coverage flag in Jenkins)
  collectCoverageFrom: [
    '../backend/**/*.js',
    '!../backend/server.js',         // entry point, tested end-to-end
    '!../backend/db/connection.js',  // thin wrapper
    '!**/node_modules/**',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: './reports/coverage',
};
