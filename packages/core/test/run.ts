/**
 * Test entry point for @ppl/core.
 * Run via: npm test (from this package) or npm test (from root)
 */
// Runtime tests
import "./matcher.runtime.test"
import "./type-graph.runtime.test"
import "./projection.runtime.test"
import "./grammar.test"
import "./lowering.test"
import "./e2e.test"

// Must come last: reports on rule-name coverage accumulated by every
// lowerExpr call in the files above (see the file for why).
import "./rule-coverage.test"

// NOTE: matcher.types.test.ts is compile-time only — it verifies
// type-level narrowing via `tsc` (run via `npm run test:types`).
