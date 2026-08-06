/**
 * Test entry point for @ppl/core.
 * Run via: npm test (from this package) or npm test (from root)
 */
import "./matcher.runtime.test"
import "./type-graph.runtime.test"
import "./projection.runtime.test"

// NOTE: matcher.types.test.ts is compile-time only — it verifies
// type-level narrowing via `tsc` (run via `npm run test:types`).
