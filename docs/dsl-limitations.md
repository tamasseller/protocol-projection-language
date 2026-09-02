# DSL limitations

What the DSL will not do. Each follows from the ISA rather than from the
lowerer, and each says what to write instead.

## `/` and `%` have no opcode

`u32 a = 7; return a / 2;` → `no lowering for '/' — the ISA has no divide (isa-core.md §4.1)`.

Nothing a lowering rule can recover: there is no divide instruction, and
no codec has needed one.

Write the helper. A shift-and-subtract `udiv(n, d)` in the DSL lowers and
runs today — a `for` loop and a ternary, no ISA support — and a caller gets
`q = udiv(n, d)` at one `CALL`. Two cheaper paths if it ever matters: a
constant power-of-two divisor is `SHR #k` / `AND #(2ᵏ−1)` and would be a
fold rule, and an application with a divider in native code can expose it
as an extension op.

There is now somewhere for a real one to go: isa-core.md §5.3's
`MISC_BINARY` escape is held empty for exactly this, so `UDIV`/`IDIV`/`MOD`
would be a sub-code assignment rather than another renumbering of the
opcode space.

## A `for` init's register outlives its name

`for(u32 i = 0; …)` scopes `i` to the loop; its register is not reclaimed
until the enclosing block ends.

This is C's own equivalence minus a construct the DSL does not have. C
defines `for (decl; c; u) B` as `{ decl; while (c) { B; u; } }` — *with*
the enclosing braces, and a standalone brace-block is excluded (§10.3): a
block's TOS reset is its `BLOCK_END`, and only a `BR_TABLE` case or `LOOP`
sub-block has one. The leaked register is the bare-block exclusion seen
from the other side; the lowerer already does better than the literal
rewrite would, by scoping the name.

A scope can be bought where it matters: wrapping the loop in `if (1) { … }`
gives the counter a real `BLOCK_END`, and the next declaration reuses its
slot. Four bytes, and it clobbers acc at a statement boundary.

Against isa-rationale.md's phrasing: a bare block is excluded because its
*natural* lowering has no `BLOCK_END`, not because one could not be
synthesized — `if (1) { … }` is that synthesis.

## A shared `switch` body needs adjacent labels

`case 0: case 1: X` works — the empty label's case is a lone `FALLTHROUGH`
(isa-core.md §4.5), which continues into the case physically next in the
table. `case 0: case 5: X` does not:

```
switch(x) { case 0: case 5: return 1; default: return 9; }
  → Empty body for case 0: it can only share the body of case 1, which this
    switch does not have — repeat the statements under each label instead
```

The table's slots *are* the label values, so the case following label 0 is
label 1's, and between 0 and 5 sit gap fillers — each a copy of the
`default:` clause, since `BR_TABLE`'s index is exact below `N` and a gap
cannot share `case[N]`'s code. Falling into one would run the default
rather than the shared body.

That copying is also why a substantial `default:` clause stops the lowerer
merging runs across a gap at all: a gap costs one copy of it per missing
label, against roughly seven bytes for a second table (`lowerSwitch`'s
`CHAIN_LINK_BYTES`). With no `default:` clause a gap filler is a lone
`BLOCK_END` and runs up to six apart still merge.

Write the statements under each label. Two labels far apart rarely share a
body in practice, and where they do, the alternative would be for the
lowerer to duplicate the body — a size decision it makes nowhere else.

## A `switch` case still cannot be spelled as a no-op

Distinct from the above: "this label does nothing, and does not share the
next one's body" has no syntax, because an empty body now *means* sharing.
Omitting the label sends that value to the default instead, so with a
default present there is no way to say it. An empty statement
(`case 3: ;`) would give one.
