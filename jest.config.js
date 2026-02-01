/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  collectCoverageFrom: [
    "background.js",
    "options.js",
  ],
  verbose: true,
};

module.exports = config;
