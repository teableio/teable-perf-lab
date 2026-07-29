// The one timer promise.
//
// This was re-declared nine times across the framework and the scripts layer
// under three names (`sleep`, `delay`, `wait`). Plain JavaScript rather than
// TypeScript so the `.mjs` report-stage scripts can import it too, without
// depending on `--experimental-strip-types` at their call site — the same
// reason `atomic-file.js` is plain JavaScript.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
