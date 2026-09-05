/**
 * The core layer's suites, imported by ../run.ts.
 */
import "./matcher.runtime.test"
import "./type-graph.runtime.test"
import "./resolver.runtime.test"
import "./metamodel.runtime.test"
import "./reconcile.runtime.test"

// NOTE: matcher.types.test.ts is compile-time only — it verifies
// type-level narrowing via `tsc` (run via `npm run test:types`).
