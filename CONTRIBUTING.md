# Contributing

Contributions are welcome. Pull requests are read, and not all of them are
merged. If you are about to spend real time on something, open an issue first
and say what you intend to do.

## before you open a pull request

Run all four, from a clean checkout. Node 18 or newer.

```
npm ci            # the locked dependency set, not npm install
npx tsc -noEmit   # typecheck
npm test          # the full suite
npm run build     # production build
```

`npm ci` rather than `npm install`: it installs exactly what
`package-lock.json` pins, and it fails instead of quietly changing the lock.

## the rules that matter

**Test pen and touch changes on real hardware.** Input arbitration cannot be
judged from unit tests. Palm rejection, the touch assist, the scroll-follow
layer and anything touching `pointerrawupdate` need a pen and a tablet, and
the pull request should say what you tested on.

**Keep storage backward-compatible.** A sidecar written by an older
Handwriting must still load, and unknown fields must survive a round trip.
`docs/storage.md` says which parts of the format are stable and which are
internal. If you need a format change, raise it in an issue first.

**Add a failing-first test for a defect.** Write the test, watch it fail
against the current code, then fix it. A test that passes before your change
proves nothing about the bug. The suite has several examples that name the
exact damage they reproduce.

**No telemetry, no required network access, no dynamic dependency
installation.** Handwriting does not phone home, does not need a network, and
does not fetch code at runtime. A change that adds any of those will not be
merged.

**Explain causes in comments, not restatements.** The comment that earns its
place says why the code is shaped that way and what broke without it. Several
files carry hardware findings that are the only record of why an invariant
exists; do not delete those.

## licensing

Contributions are submitted under `AGPL-3.0-only`, the same license as the
rest of the project. By opening a pull request you are offering your change
under those terms.

There is no contributor license agreement and no copyright assignment. You
keep the copyright in what you wrote.
