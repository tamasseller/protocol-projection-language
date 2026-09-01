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

## A `switch` case cannot be spelled as a no-op

An empty case body is rejected: in C it means fallthrough into the next
case, and no opcode reaches one case's code from another (§4.5). Omitting
the label instead sends that value to the default. So with a default
present, "this label does nothing" has no spelling.

The dispatch is not the limitation — an empty case *slot* is exactly a
no-op, and gap-filling emits them. What is missing is an unambiguous
syntax: an empty statement (`case 3: ;`) would give one, and would still
leave `case 0: case 1: X` rejected.
