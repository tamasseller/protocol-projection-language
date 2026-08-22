# Inline IR Syntax Highlighting

A VS Code extension that highlights C syntax inside `` ir`...` `` tagged
template literals in TypeScript and JavaScript, the authoring surface for
[`@ppl/machine`](../machine)'s bytecode DSL
(`packages/machine/docs/isa-core.md` §10).

Injects `syntaxes/ir.tmLanguage.json` into `source.ts`/`source.tsx`/
`source.js`/`source.jsx`, scoped as `meta.embedded.block.c.ir-dsl`, and
italicizes embedded blocks by default while leaving `${...}` interpolations
in the host language's own styling.

```sh
npm run build        # vsce package → vscode-inline-ir-<version>.vsix
```

Install the packaged `.vsix` with `code --install-extension`.
