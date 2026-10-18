// tests/babel.config.js
// Lets Jest load the frontend's ES-module sources (frontend/src/**/*.js uses
// `export`, which Jest cannot parse without a transform). Only the test
// runner uses this config; the React app keeps using react-scripts' own Babel.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};
