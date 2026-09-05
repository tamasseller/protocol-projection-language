/**
 * Test entry point for @ppl/machine.
 * Run via: npm test (from this package) or npm test (from root)
 */
import "./grammar.test"
import "./ir.test"
import "./bytecode.test"
import "./jit-armv6m.test"
import "./lowering.test"
import "./e2e.test"
import "./types.test"
import "./ternary.test"
import "./operators.test"
import "./switch.test"
import "./dispatch.test"
import "./declarations.test"
import "./scopes.test"
import "./diagnostics.test"
import "./signature.test"
import "./validate.test"
import "./vm.test"
import "./extension.test"
import "./raise.test"
import "./algorithms.test"
import "./coverage-sweep.test"
import "./fold-sweep.test"

// Must come last: reports on rule-name coverage accumulated by every
// lowerExpr call in the files above (see the file for why).
import "./rule-coverage.test"
