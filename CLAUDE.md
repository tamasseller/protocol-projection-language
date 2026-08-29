# Repo conventions

## Comments

Default to no comment. Add one only when genuinely justified, and then keep it very short — one line at the site, stating the invariant or the non-obvious constraint.

Never write a comment that narrates the change being made: "this used to live in X", "moved here from Y", "what the old stub did", "now that Z is gone". Such wording is written from the perspective of a diff, and becomes noise as soon as the diff stops existing.

No large comment blocks. If a design decision's reasoning must be preserved, it belongs in the design doc (e.g. `jit-armv6m/docs/design.md`), not in the source — and one tight paragraph there, not an essay.

Existing prose in this repo is verbose in places. That is not licence to add more.

## Docs

`docs/TODO.md` and similar: status first, one fact per line. Not multi-paragraph rationale.
