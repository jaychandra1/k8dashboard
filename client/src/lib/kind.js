// Compatibility shim — the registry moved to ./kinds.js (single source of truth).
// Existing imports of `KIND_TYPE` / `kindType` keep working; new code should
// import from './kinds'.
export { KIND_TYPE, kindType } from './kinds.js';
