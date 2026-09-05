/**
 * Test entry point for ppl — one runner over all three layers, in
 * dependency order so a core failure reports before the things built on
 * it do.
 *
 * Run via: npm test
 */
import "./core/run"
import "./codecs/run"
import "./target-js/run"
