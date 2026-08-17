# Contributing

*[Version française](CONTRIBUTING.fr.md)*

Outside contributions are welcome. This page says what the repository expects, so that a pull
request does not get sent back over something nobody told you.

## Before writing code

Open an issue first for anything beyond a fix. The extension has a deliberately narrow scope —
watching Claude Code sessions — and the fastest way to have work rejected is to widen it
without discussion.

For a bug, say which editor and which macOS version, and what `~/.koh-vibe/events/` contains
at the moment of the problem. **Never paste a hook payload as-is**: it holds absolute paths,
prompts and sometimes secrets. Say what is in it, not what it says.

## The flow

Branch off `dev`, open your pull request against `dev`. `main` only ever receives `dev`, and
one merged pull request there is one released version.

```bash
git switch -c fix/what-you-are-fixing dev
```

Before pushing:

```bash
pnpm typecheck   # src and test alike
pnpm test
pnpm package     # proves the extension still packages
```

CI runs those three on macOS, which is the only platform this extension supports. It reads no
secret, so it runs on pull requests from forks like any other.

To try your build for real, from the integrated terminal of the editor you want it in:

```bash
scripts/install-local.sh    # then: Developer: Reload Window
```

It packages, then installs into **that** editor rather than into whichever one owns `code` on
your PATH — Cursor ships a binary called `code` of its own, and some editors put none there at
all. It refuses instead of guessing when the terminal belongs to no editor.

## What the review looks at

**Tests come with the change, not after it.** A behaviour without a test is a behaviour nobody
will dare touch later. A test that passes for the wrong reason is worse than none: check that
it fails when you revert the fix.

**Comments explain the why, never the what.** The code already says what it does. What it
cannot say is which trap you avoided, and that is what the next person needs.

**No `any`.** The type checker is strict, unused locals included. If a type genuinely resists,
a narrow cast with a comment beats loosening the whole file.

**Nothing personal in the repository.** No absolute path from your machine, no client name, no
real session id. Fixtures use `/Users/dev/projet`.

## Language

**Code is English**: symbol names, comments, commit messages, pull request titles and bodies,
branch names, issue labels.

**Information files are bilingual**: `README.md` and `CONTRIBUTING.md` have a `.fr.md` twin.
English is authoritative and French follows; both change in the same commit. `CHANGELOG.md` is
English only — it is generated from pull request titles, which are English.

**Displayed text follows the user.** Nothing user-visible is hardcoded in one language:
contributed labels go through `package.nls.json`, runtime ones through `vscode.l10n.t()`. The
string written in the source is the English one; `l10n/bundle.l10n.fr.json` carries French.

Adding a language means one file — `l10n/bundle.l10n.<lang>.json` — plus
`package.nls.<lang>.json` for the contributed labels. A missing translation falls back to
English rather than to an empty label, so a partial bundle is perfectly acceptable.

## Merging

The repository owner is the only reviewer, and `main` is protected: no direct push, a pull
request with a code-owner approval, and green CI.

Nothing here is a promise that a contribution will be merged. It is a personal project; the
scope stays narrow on purpose.
