# ppl — Protocol Projection Language

One semantic schema, projected into every artifact a protocol needs: a wire
codec, host-language type declarations, an accessor surface. Write the
meaning of your data once; the encoder, the decoder and the types are
derived from it, and cannot drift apart.

## Using it

A schema is a value, built from the metamodel's combinators:

```ts
import {named, struct, integer, list} from "ppl"

const Reading = named("Reading", struct({
    sensor: integer(0, 255),
    value:  integer(-32768, 32767),
}))
const Packet = named("Packet", struct({
    deviceId: integer(0, 0xFFFFFFFF),
    readings: list(Reading, 16),
}))
```

Projecting it to a binary codec gives two programs, one per direction —
direction is a property of a whole program, never a flag inside one:

```ts
import {buildCodec, binaryEncodeRules, binaryDecodeRules} from "ppl"

const encodeProgram = buildCodec(Packet, binaryEncodeRules, undefined)
const decodeProgram = buildCodec(Packet, binaryDecodeRules, undefined)
```

Those are `mog-core` programs — bytecode, not JavaScript — so the same
codec runs on the reference VM here and, compiled, on a Cortex-M0 through
[mog-jit](https://github.com/tamasseller/mog-jit). Running the encoder over
the packet above yields 11 bytes, and the decoder returns the value it
started from:

```
[42,0,0,0,2,1,235,0,2,216,255]
{"deviceId":42,"readings":[{"sensor":1,"value":235},{"sensor":2,"value":-40}]}
```

The same schema projected to TypeScript gives the declarations to hold that
value:

```ts
import {projectTSTypes, emitTSDeclarations, tsTypeRules} from "ppl"

emitTSDeclarations(projectTSTypes(Packet, tsTypeRules))
```

```ts
export interface Packet {
  readonly deviceId: number;
  readonly readings: Reading[];
}

export interface Reading {
  readonly sensor: number;
  readonly value: number;
}
```

Every projection above is a *rule list*, passed in explicitly. An
application prepends its own rules to preempt a default for one shape —
that is the whole extension model, and nothing here privileges the
built-in rules over yours.

[example/](example) is a worked protocol: one schema, its binary codec, a
JSON encoder and its TypeScript declarations, with the generated output
committed so it can be read rather than imagined.

## Layout

| Path | What |
|---|---|
| `src/core/` | the metamodel, the structural pattern vocabulary (`TypePattern`/`matchType`), `createResolver`'s cycle-safe rule dispatch, and `reconcile` |
| `src/codecs/` | the codec `Extension` that makes a codec body authorable as `ir` text, and the rule libraries that use it — binary, delta-LEB128, JSON |
| `src/target-js/` | the TypeScript target: type projection, the compiled-codec emitter, and the runtime those emitted modules import |

One package. The three directories are a layering — `core` knows nothing of
codecs, `codecs` nothing of TypeScript — enforced by the import graph
rather than by npm.

[mog-core](https://github.com/tamasseller/mog-core) is a dependency, not a
layer here: it supplies the bytecode ISA, the lowering pipeline and the VM
a codec program runs on.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the three layers and what
  belongs in each.
- [docs/codec-extension.md](docs/codec-extension.md): the codec opcode
  vocabulary and its ABI.
- [docs/ROADMAP.md](docs/ROADMAP.md): what is built, what is open.

## Commands

```sh
npm run build        # tsc → dist/
npm test             # every layer, in dependency order
npm run test:types   # tsc --noEmit over the test tsconfig
```
