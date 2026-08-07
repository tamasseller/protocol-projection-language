/**
 * Test entry point for @ppl/example.
 *
 * Runs all three integration suites. Each proves that a GENERIC package
 * projection (@ppl/target-cpp, @ppl/codecs, @ppl/target-js), when composed
 * over this project's schema via compose.ts, produces correct output.
 */
import "./c-target.test"
import "./codec.test"
import "./ts-target.test"
