# Repo conventions

## Comments

Default to no comment. Add one only when genuinely justified, and then keep it very short — one line at the site, stating the invariant or the non-obvious constraint.

Never write a comment that narrates the change being made: "this used to live in X", "moved here from Y", "what the old stub did", "now that Z is gone". Such wording is written from the perspective of a diff, and becomes noise as soon as the diff stops existing.

No large comment blocks. If a design decision's reasoning must be preserved, it belongs in the design doc (e.g. `mog-jit/docs/design.md`), not in the source — and one tight paragraph there, not an essay.

Existing prose in this repo is verbose in places. That is not licence to add more.

## Docs

Status first, one fact per line. Not multi-paragraph rationale.

Two files at the workspace root, and no others of their kind — no per-repo
`TODO.md`, no handover or notes file anywhere:

- `docs/TODO.md` is the master plan, written by hand. Never add to it. Change
  it only when told to, and then only what you were told.
- `docs/FINDINGS.md` is where every discovery goes, from any repo. It is read
  in order to be picked from, so it stays short: an entry leaves when it is
  promoted, fixed, or falsified. What a fix pins belongs in a test; what a
  decision preserves belongs in the repo's own design doc.
