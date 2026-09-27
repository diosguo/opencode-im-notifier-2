// Local-development entrypoint.
//
// OpenCode 2.x resolves a local (directory) plugin by looking for a root
// `server` or `index` module rather than reading package.json "exports".
// This file re-exports the compiled plugin so the repository directory can be
// used directly, e.g. `"plugins": ["/path/to/opencode-im-notifier"]`.
// npm-installed usage resolves through package.json "exports" -> dist/index.js.
export { default } from "./dist/index.js";
