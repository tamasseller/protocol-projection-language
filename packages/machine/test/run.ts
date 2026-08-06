/**
 * Test entry point for @ppl/machine.
 * Run via: npm test (from this package) or npm test (from root)
 */
import "./grammar.test"
import "./ir.test"
import "./bytecode.test"
import "./lowering.test"
import "./e2e.test"
import "./validate.test"
import "./extension.test"
import "./algorithms.test"
import "./coverage-sweep.test"

// Must come last: reports on rule-name coverage accumulated by every
// lowerExpr call in the files above (see the file for why).
import "./rule-coverage.test"
