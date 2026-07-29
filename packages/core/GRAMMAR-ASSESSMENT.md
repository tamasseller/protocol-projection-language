# Grammar Assessment: `grammer.pegjs`

## Verdict: ✅ **Fulfills its purpose.** The grammar correctly describes a minimal C subset suitable for embedded IR function bodies. No parsing bugs found. One fragile pattern worth cleaning up.

---

## What It Gets Right

### ✅ Type System
- **Single `u32` type** — `DeclarationStatement` hardcodes `"u32"` as the only type keyword. No `int`, `char`, `float`, `void`, `struct`, `union`, `typedef`, or `sizeof`.

### ✅ Expressions (Complete & Correct Precedence)
| Level | Operators | Rule | Notes |
|-------|-----------|------|-------|
| 1 (lowest) | `=` `+=` `-=` `*=` `/=` `%=` `<<=` `>>=` `&=` `^=` `|=` | `AssignmentExpression` | Right-associative ✅ |
| 2 | `?:` | `ConditionalExpression` | Right-associative (alternate is `AssignmentExpression`) ✅ |
| 3 | `\|\|` | `LogicalORExpression` | Left-associative via `buildBinary` ✅ |
| 4 | `&&` | `LogicalANDExpression` | Left-associative ✅ |
| 5 | `\|` | `BitwiseORExpression` | Left-associative ✅ |
| 6 | `^` | `BitwiseXORExpression` | Left-associative ✅ |
| 7 | `&` | `BitwiseANDExpression` | Left-associative ✅ |
| 8 | `==` `!=` | `EqualityExpression` | Left-associative ✅ |
| 9 | `<` `>` `<=` `>=` | `RelationalExpression` | Left-associative ✅ |
| 10 | `<<` `>>` | `ShiftExpression` | Left-associative ✅ |
| 11 | `+` `-` | `AdditiveExpression` | Left-associative ✅ |
| 12 | `*` `/` `%` | `MultiplicativeExpression` | Left-associative ✅ |
| 13 | `++` `--` (prefix) `+` `-` `~` `!` | `PrefixExpression` | Unary ✅ |
| 14 (highest) | `++` `--` (postfix) | `PostfixExpression` | Unary ✅ |

This is standard C precedence. No surprises.

### ✅ Control Flow (All Present)
| Construct | Rule | Duff's Device? |
|-----------|------|----------------|
| `if` / `if-else` | `IfStatement` | N/A |
| `while` | `WhileStatement` | N/A |
| `do-while` | `DoWhileStatement` | N/A |
| `for` | `ForStatement` | N/A |
| `switch-case` | `SwitchStatement` / `SwitchCase` | **Prevented**: each case strictly owns its `Statement*` block — labels and loops can't interleave |
| `break` | `BreakStatement` | N/A |
| `continue` | `ContinueStatement` | N/A |
| `return` | `ReturnStatement` (argument optional) | N/A |

### ✅ Dangling-else Resolution
PEG ordered choice naturally binds `else` to the nearest `if`. The grammar does this correctly — `if (a) if (b) c; else d;` binds `else` to the inner `if`. No ambiguity.

### ✅ For-Loop Init Handling
Correctly handles all three forms:
- `for (u32 i = 0; ...)` — init is a `DeclarationStatement` (includes its own `;`)
- `for (i = 0; ...)` — init is an `ExpressionStatement` (unpacked to expression in action)
- `for (;;)` — init is a bare `;`, returns `null`

### ✅ What's Correctly Excluded
- No pointers (`*`, `&` as unary address-of)
- No arrays (`[]`)
- No struct/union/enum/typedef
- No function definitions
- No comma operator
- No labels / `goto`
- No `sizeof`
- No casts
- No boolean/char/string literals
- No float literals

---

## Issues Found

### 🟡 Moderate: Fragile `SwitchCase` Action (lines 92–97)

```pegjs
SwitchCase
  = ("case" _ test:Expression _ ":" _ / "default" _ ":" _ { return { test: null }; })
    consequent:Statement* {
      return { type: "SwitchCase", test: test && test.test !== null ? test : null, consequent };
    }
```

**Problem**: The `test && test.test !== null` check works by accident — it relies on the fact that expression AST nodes don't have a `.test` property, while the default-case inline action returns `{test: null}`. This is fragile and confusing.

**Recommended fix** — split into two clean alternatives:

```pegjs
SwitchCase
  = "case" _ test:Expression _ ":" _ consequent:Statement* {
      return { type: "SwitchCase", test, consequent };
    }
  / "default" _ ":" _ consequent:Statement* {
      return { type: "SwitchCase", test: null, consequent };
    }
```

### 🔵 Minor: `DeclarationStatement` Wraps in Single-Element Array

```pegjs
declarations: [{ type: "VariableDeclarator", id, init: init !== null ? init : null }]
```

This always produces a single-element `declarations` array (mirroring ESTree convention). This is fine for a single-type language, but the grammar could simplify to a flat node since multi-declarator (`u32 a, b, c`) isn't supported.

### 🔵 Minor: No `peggy` Dependency or Build Step

`package.json` has no `peggy` or `pegjs` dependency, and there's no script to compile the grammar into a parser. The `.pegjs` file is currently a spec-only artifact. You'll need:

```json
"devDependencies": { "peggy": "^4.1.1" }
```
```json
"scripts": { "build:parser": "peggy packages/core/grammer.pegjs -o packages/core/src/parser.ts" }
```

### 🔵 Minor: Postfix `++`/`--` on Non-LValues

`PostfixExpression` allows `foo()++` and `5++` because it matches any `PrimaryExpression`. C rejects these at the semantic level, not the grammar level. The same approach will work here — let the semantic checker reject non-lvalue postfix targets. No grammar change needed.

---

## Summary

| Category | Count |
|----------|-------|
| Parsing bugs | **0** |
| Missing required features | **0** |
| Unwanted features present | **0** |
| Fragile code worth fixing | **1** (SwitchCase action) |
| Minor observations | **3** |

**The grammar is ready to wire into a build pipeline.** The one cleanup (SwitchCase) is cosmetic but worth doing before the grammar grows.
