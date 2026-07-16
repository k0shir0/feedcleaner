// web-ext auto-discovers this file in the working directory.
//
// Mozilla add-on policy: packages must not contain unused files. Everything
// listed here is development-only — Module B build inputs (filter-lists/,
// build/), docs, and repo metadata — and must never ship in the XPI.
// These entries are appended to web-ext's defaults (hidden files,
// node_modules, web-ext-artifacts, *.zip/*.xpi).
export default {
  ignoreFiles: [
    "build",
    "docs",
    "filter-lists",
    "README.md",
    "LICENSE",
    "web-ext-config.mjs",
  ],
  build: {
    overwriteDest: true,
  },
};
