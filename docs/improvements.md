# Performance
## Lowerer

## JIT

7 An arm whose sibling is empty still emits its exit branch — a B to the very next halfword: 2 bytes, and a taken branch on every execution of the non-empty arm. translateIfThen is the fast path for an empty case[0] and there is no mirror for an empty case[1], which is what `if (c) {} else { ... }` lowers to. The skip needs a peek past arm 0's BLOCK_END, and must drop the unguarded flushPool with the branch — arm 0 would otherwise fall through into the pool, the same reason the FALLTHROUGH arm skips both.

### Masterplan

So my grand idea to further improve the machinery is this:

Rearrange opcodes
 - 97 LOOP -> stays same but maybe should indicate the it is pretest loop (LOOP_PRE?)
 - 98 BR_TABLE #1 -> becomes LOOP_POST
 - 99 FALLTHROUGH -> BR_TABLE #1 is moved here so it is next to extended form
 - 125 MISC_CF -> MISC_BINARY moves to here
 - 127 MISC_BINARY -> MISC_OTHER takes its place with several sub-codes for:
	- FALLTHROUGH 
	- DEFAULT (a new terminator) also for BR_TABLE that jumps to the default block.
        - DROP #n with several small literal variants, that drops n elements from the top of the stack.

Swap the order of loop blocks in bytecode, body first, condition second in order to facilitate the JIT generating "jump to condition, body, condition, jump to body if true".

The post-test LOOP variant enables implementing do-while support, the JIT behavior differs from the pretest case only in not emiting the initial jump. It needs a DSL addition.

`for` loops that have intializer declaration can use DROP #n to clean it up.

This achieves C parity on the loop side, but DROP also allows implementation of bare blocks by implementing their cleanup as well.

Full C switch semantics can be encoded relatively efficiently as well with full or partial fallthrough and gapfilling with DEFAULT. So the DSL can be changed to match C exactly there as well.  

This pack removes afaik almost all the arbitrary structural restrictions compared to C99 regarding the things that are implemented. Still no struct, union, enum, typedef, pointers, arrays, etc... but those are absent by design.

In-place (+= type) operator desugaring and multiple value declarations could be implemented lowerer side as well.