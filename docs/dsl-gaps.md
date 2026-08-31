# DSL surface gaps

What `grammer.pegjs` accepts that `lower.ts` does not handle, or handles
wrongly. Every entry was reproduced at b4e8f87 by running the case through
parse → lower → validate → run; the repro line is the observed result, not
a prediction.

Ordered by severity: silent wrong output, then crashes, then clean
refusals, then documentation that describes features which do not exist.

## Silent — validates, runs, wrong answer

### A name declared twice aliases the first slot

Repro: `u32 a = 1; u32 a = 2; return a;` → 1.
Emits `CONST 1|PUSH|CONST 2|PUSH|LOAD 0|RETURN`: the second declaration takes a slot the name never points at.
Cause: `RegAlloc.alloc` is idempotent by name (lower.ts:94) but `lowerVarDecl` pushes unconditionally.
Also: `for(u32 i = 0; …) …` then `u32 i = 5; return i;` → 2, because a `for` init has no scope of its own.
Also: a local shadowing a procedure argument returns the argument (`proc(["x"], "u32 x = 5; return x;")` called with 9 → 9).
The orphaned slot shifts every later declaration's index too.
Fix: allocate a fresh index per declaration, or reject a same-scope redeclaration.

### `switch` ignores its case labels

Repro: `switch(a) { case 1: return 1; case 2: return 2; default: return 9; }` with `a = 2` → 9.
Dispatch is positional: `lowerSwitch` filters on `c.test !== null` (lower.ts:504) and never reads the value.
Correct only when the labels happen to be `0..N-1` in source order.
C fallthrough is absent for the same reason: `case 0: case 1: return 1;` makes `case 0` an empty block, so `a = 0` leaves the switch.
isa-core.md §7.1 documents the ISA's index dispatch, not this restriction on the DSL.

### `for` with an omitted test never iterates

Repro: `for(u32 i = 0; ; i = i + 1) { return 1; } return s;` → `s`.
An absent test emits an empty condition sub-block, so `LOOP | BLOCK_END` dispatches on whatever acc happened to hold (lower.ts:559).
Validates clean, because the stale acc genuinely is live.
`while(1)` is unaffected — a real `CONST #1` reaches acc.

### Extra call arguments misbind

Repro: a 2-argument procedure called with `(1, 2, 3)` computes on `(2, 3)`.
The callee's frame base is `tos - argCount`, so surplus pushes shift the mapping; the leftover is dropped at the next block close.
Too *few* arguments is caught, but by the validator (`CALL 1: only 0 value(s) pushed, needs 1`), not at the call site.
No arity check exists in `lower.ts`.

### A leading zero is not octal

Repro: `return 010;` → 10.
`DecimalLiteral` takes `[0-9]+` with no octal rule.

## Crash

### A declaration without an initializer

Repro: `u32 a;` → `TypeError: Cannot read properties of null (reading 'type')`.
`lowerVarDecl` dereferences `d.init!` (lower.ts:251); the grammar makes the initializer optional.
isa-core.md §10.4 shows `u32 x;` as valid.

## Parses, refuses to lower

All of these fail on an `assert.ok` whose message names neither the
operator nor a source position — e.g. every one of the ten compound
assignments reports `Failed to lower expression statement`.

| Surface | State |
|---|---|
| `+=` `-=` `*=` `/=` `%=` `<<=` `>>=` `&=` `^=` `\|=` | no rule for any of the ten; the desugared `a = a + 1` lowers, and has a REG_REG rule of its own |
| `++` / `--`, prefix and postfix | no rule, in any position |
| `!` | no rule; `logicInvertRoot` only inverts at the root of an `if`/`while` test |
| `+` (unary) | no rule |
| `&&` `\|\|` | no rule, including in a test |
| `/` `%` | no ISA opcode exists — needs an extension op or a helper procedure, not a rule |

`OP_TABLE` (rules.ts:101) and `UNARY_OPS` (rules.ts:123) are the whole
inventory of what lowers.

`&&`/`||` want the same machinery the ternary uses: lift into a `BR_TABLE`
writing a slot reserved before the dispatch, with the right-hand side
inside a case (isa-core.md §8.7).

## Documentation describing features that do not exist

isa-core.md §10.2 lists compound assignment, `++`/`--` and `0b…` literals. None are implemented; `0b101` is a parse error.
isa-core.md §10.3 lists casts as excluded. They exist (`u8(x)`, §4.3's extend ops).
isa-core.md §10.4 says "All values are `u32`". There are six types.
isa-core.md §10.4 shows `u32 a, b, c;` as valid. The grammar takes one declarator per statement; that line does not parse.

## Correctly excluded, verified

`do`/`while`, `break`/`continue`, bare block statements, the comma
operator and character literals are all rejected at the grammar, each for
a reason isa-core.md §10.3 gives.
