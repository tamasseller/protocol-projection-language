# Implementation Planning Notes

> Status: working notes. Captures lowering strategy, pipeline milestones, and
> open implementation questions. Non-normative; the normative reference is
> [isa-core.md](./isa-core.md).

## Pipeline overview

```
DSL source ──PEG──▶ AST fragment ──stitch──▶ proc IR ──lower──▶ bytecode ──serialize──▶ blob
   (ir`)              (ast.ts)     (merge)    (encoder)     (bin)
```

Each box is a distinct layer. Layers may be implemented in any order once the
contract between them is fixed; the contracts are the ISA's normative
boundaries.

### Milestones (suggested order)

1. **PEG parser + `ir` tag** — parse C-subset string → `IrFragment` AST.
   Grammar already exists at `packages/core/grammer.pegjs`; the `ir` tag wraps
   `parse()` and returns a tagged object. *Smallest unit; unblocks everything.*
2. **Lowerer (pure core)** — AST → IR instruction sequence. No extensions, no
   codec ops. Exercises the full expression/control-flow lowering rules
   (§22). This is where the algorithm below lives.
3. **Bytecode encoder** — IR instruction sequence → byte stream per Part V.
   Pure serialization; no semantic decisions.
4. **Bytecode decoder + validator** — byte stream → validated program.
   Implements Part IV validation rules (TOS balance, call-graph acyclicity,
   dead-code rejection, block well-formedness).
5. **Stitching layer** — combine multiple `IrFragment`s into one procedure.
   Resolve labels across fragments, merge scopes, deduplicate declarations.
6. **Integration layer** — procedure definition, ABI, extension call
   resolution. Out of scope for the Generic Core (§21.2); per-application.

Milestones 1–4 are Generic-Core-only and can be tested end-to-end on the
examples in Appendix A. Milestones 5–6 add the codec domain.

---

## Expression lowering — adapted Sethi-Ullman

### Why adapted

Standard Sethi-Ullman minimizes **register pressure** on a load/store
machine. This ISA's accumulator+stack model has a different cost surface:

- A leaf is addressable as an operand directly (0 stack cost), so leaf weight
  is **0**, not 1.
- `[--tos]` (combo 5) is 1 byte and consumes the top of stack — the stack is
  the cheapest temp.
- But **non-commutative ops have a reversal trap**: if the left subtree is on
  the stack and we need `L OP R`, the compact `OP [--tos]` gives `acc OP pop`
  = `R OP L`, which is wrong for non-commutative ops. `RSUB [--tos]` exists
  (escape tier, 2 bytes) but costs more than the compact `SUB [--tos]`.

This means pure heaviest-first is **not** byte-optimal for non-commutative
ops. The adaptation below accounts for the escape-tier asymmetry.

### Phase 1: Weight annotation (bottom-up)

Walk the AST assigning a weight = worst-case stack depth needed to evaluate
the subtree without spilling.

| Node | Weight |
|------|--------|
| Leaf (constant, local) | 0 |
| Unary op | weight of child |
| Binary op, `W_L == W_R` | `W_L + 1` |
| Binary op, `W_L != W_R` | `max(W_L, W_R)` |

Leaf weight 0 is the key deviation from textbook SU — leaves don't consume a
slot because they're addressable inline.

### Phase 2: Emission — per-op evaluation order

For a binary node `L OP R`:

**Commutative ops** (`ADD`, `MUL`, `AND`, `OR`, `XOR`, `EQ`, `NE`):
heaviest-first. Eval the heavier child into `acc`, push if the other child
is complex (weight > 0), eval the lighter child, emit `OP [--tos]` or `OP
operand` if the lighter child is a leaf.

**Non-commutative ops** (`SUB`, `SHL`, `SHR`, `LT_S/U`, `LE_S/U`): **right
child first**, unless the weight difference forces a spill. Reason: emitting
`OP [--tos]` with L on the stack gives `R OP L` (wrong); the reverse path
`L OP R` is achievable directly only when L is in `acc` and R is the popped
operand. Evaluating R first means R goes on the stack, L goes into `acc`, and
`OP [--tos]` computes `L OP pop = L OP R` correctly using the compact tier.

> The exception: if `W_L >> W_R`, evaluating R first means L evaluates with R
> on the stack — potentially forcing a spill if L itself is deep. The lowerer
> compares the projected byte cost of (right-first + possible spill) vs
> (left-first + RSUB escape) and picks the cheaper. For shallow codec
> expressions (depth ≤ 2), right-first is almost always strictly better.

### Phase 3: Operand-mode selection at the emit node

When the final ALU/comparison op is emitted, the lighter child (or the only
child, if the other was the leaf) becomes the addressed operand. Select the
mode by this priority (cheapest first):

| Operand form | Mode | Cost | When usable |
|--------------|------|------|-------------|
| Per-op inline literal (`1` for ADD, `0xFF` for AND, `0` for MOVE, …) | `imm-inline` | 0 extra bytes | Operand is that exact constant for that op |
| `#0` for a comparison | `imm-zero` | 0 extra bytes | Comparison with zero |
| Top of stack | `[--tos]` (pop) | 0 extra bytes (but needs prior PUSH) | Other child was complex, already pushed |
| Local variable | `rN` | 1 byte trailing | Operand is a named local |
| Arbitrary constant | `imm-extended` | 1–5 bytes LEB128 | None of the above |

### Phase 4: Result-destination selection (root of statement-level expr)

If the expression's result feeds an assignment to a local (`x = expr`) or a
compound assignment (`x op= expr`), and the addressed operand is also `x`,
select **combo 2** (write-back to register) — one instruction instead of
load+op+store. Example: `count += x` → `ADD r_count → r_count` (1 instruction,
2 bytes).

This is a separate optimization applied at the statement root, orthogonal to
the tree-walk evaluation order.

### Open question: comparison result feeding a value

Non-commutative comparisons (`LT`, `LE`) with a complex right operand and a
leaf left have no clean reverse in the compact tier (GT/GE are escape-only).
In practice these are rare — comparisons usually feed `BR_TABLE` (a branch),
where the **complementary-comparison** mechanism (§22.2) sidesteps the
problem. When a comparison result is consumed as a value (e.g. assigned to a
local), the lowerer should restructure to put the complex operand on the
right side of a direct compact comparison.

---

## Open implementation questions

### From the ISA design

- **Per-op inline literal values** (§17.3): the bitwise defaults (`0xFF` for
  AND, `0x80` for OR) are guesses. Need corpus measurement to confirm.
- **Register-index inline packing**: currently always a trailing byte. Could
  pack r0–r7 inline using reserved mode codes if measurement shows register
  ops are hot.
- **Comparison compact tier**: should `GT`/`GE` be promoted back if
  branch-inversion proves costly in real codecs?
- **BR_TABLE inline range**: currently {1,2,3,4}; may widen or narrow.

### From the lowering strategy

- **Spill heuristic**: when does right-first-for-noncommutative lose to
  left-first-plus-escape? Need a concrete cost function once the bytecode
  encoder exists.
- **Common-subexpression elimination**: not in scope for v1, but the
  register write-back (combo 2) interacts with it — a CSE'd value in a
  register can be the operand of multiple consumers without re-evaluation.

### From the integration layer

- **Stitching**: how are jump labels resolved across fragment boundaries?
  Probably per-fragment local labels + a post-stitch rename pass.
- **ABI**: how does a procedure declare its argument count and any
  extension header fields? Out of scope for the Generic Core (§21.2) but
  needs a concrete answer for the codec domain.
- **Extension call resolution**: the mechanism shape (table, framework,
  utilities) is an implementation detail — but the codec integration needs
  *some* concrete answer to start.

---

## Test strategy

### Unit tests (per layer)

- **Parser**: round-trip every DSL construct; reject every excluded form
  (pointers, arrays, `do`, `goto`, …). The existing grammar test suite at
  `packages/core/test/grammar.test.ts` is the starting point.
- **Lowerer**: each Appendix A example should produce the listed IR. Byte
  counts should match (this is also a regression test for the encoder).
- **Encoder/decoder**: round-trip every instruction format in Part V.
  Especially the escape tier and the per-op inline literal table.
- **Validator**: each §15 rule has a positive and negative test.

### Integration tests

- **End-to-end on Appendix A**: DSL source → AST → IR → bytes → decode →
  validate → execute (on a reference interpreter) → check result.
- **Round-trip property test**: for any valid program, encode then decode
  yields the same IR.

### Reference interpreter

A small TS interpreter that executes validated IR. Not a backend target —
just an oracle for testing the lowerer and encoder. Implements the abstract
machine (§2) directly: `acc`, register file, TOS, structured control flow.
