# Release workflow checks

Coverage audit baseline: published 1.4.18, source
`b7684c7daab56213c2a41d4f694fef26e3a74f0b`, tree
`62beefe5d35ecee4b01e5abf6700eef247cb548c`.
Scope: inspect existing tests and select a regression floor. No new scroll,
Insert Space, or sync defect reproduction is claimed by this audit.

## Run the automated smoke checks

`npm run test:release-smoke`

Requires the normal development dependencies and Playwright Chromium already
installed. The command runs nine unit files and four browser files, with an
explicit missing-file guard and failure propagation. It does not install a
browser, build a package, use real notes, or interact with a device. An existing
negative/sensitivity control inside a selected test is not itself a release
failure. The test's assertion must still pass.

The normal `gate` and `release` commands are unchanged. This command selects
existing coverage; it does not turn a helper test into a workflow test. The four
workflow gaps below remain open even when every selected test passes.

## What is actually covered

### Scrolling with Readable line length on and off

- `test/render/ContentOriginColumn.test.ts`, “Minimal: readable-line-width moves
  the column without moving .cm-content”: bundles production `contentOriginLeft`
  against a DOM-shaped editor and copied theme rules. Tests both width states and
  an intentionally wrong pre-1.4.9 measurement. This is browser geometry, not an
  active note with painted ink scrolling.
- `test/render/MinimalResync.test.ts`, “Minimal, short lines: readable line
  length”: checks geometry changes and observer callbacks. Read the page harness
  header: `minimalResyncPage.ts` mirrors observers, has no CodeMirror instance,
  and explicitly does not exercise the scroll listener or ViewUpdate hook.
  Its test header's “real observers” wording must not be read as mounting the
  complete production overlay.
- `test/render/ScrollExpansion.test.ts`, “mounted native scroll”: mounts the
  production overlay and real CodeMirror; covers extent growth, draw alignment,
  pan, undo/redo, camera preservation, reload, and export. Its `on` parameter is
  infinite scrolling, not Readable line length. Its snapshots after settling
  cannot exclude a transient shift before snap-back.

**Gap / owner:** Claude scroll owner and reviewer need a Readable line length
ON/OFF control with existing painted ink and measured intermediate scroll frames.
The smoke selection cannot certify transient registration or actual Obsidian.

### Repeated zoom and draw at 10%, 100%, and 400%

- `test/render/ZoomWrittenInkDrift.test.ts`, “zoomed pen capture uses the physical
  text anchor”: real CodeMirror and production overlay/pointer path in Chromium,
  including padding, immediate/settled input, pinch end/cancel, old ink, committed
  bitmap pixels, and cold serialized-byte reopen. The actual table uses 137.5%
  and 175%; each case writes once. Its bitmap sensitivity control displaces
  pixels by 8 px, demonstrating that the raster measurement sees displacement.
- `ScrollExpansion.test.ts` adds a mounted draw/pan/zoom/reopen path at scale 1,
  1.5, and 2, but not three repeated draw cycles at each requested boundary.

**Gap / owner:** O1 schedules a bounded extension of the existing zoom harness
when a writer is available. Three repeated cycles at each of 10%, 100%, 400%,
transient alignment, and device input remain unproved. Do not infer a 400% pass
from a clamp/helper test or a single 175% success.

### Insert Space guide, split, membership, undo, and cancel

- `src/inline/InsertSpace.test.ts`: pure row grouping, snapped split,
  `strokeIdsBelow`, bounds, travel and text-line helpers. Preserves whole words
  and store ordering under synthetic geometry. No guide is painted or dragged.
- `src/inline/InkHistoryIdentity.test.ts`, “insert-space in claimed/memory mode
  is one text-and-ink event across rename”: real `spaceUp` and CodeMirror history,
  but pre-moves ink, preloads membership and stubs `spaceTextChange`. Proves
  grouped text/ink undo and redo across rename, not membership selection.
- Not selected as cancellation proof: `AbandonedGestureStandsDown.test.ts`.
  Its header says the abandoned-live-stroke callback is no longer reached by the
  ordinary production route. Its cleanup result is not an Insert Space cancel
  workflow. `InkSurfaceRules.test.ts` contains source-contract assertions;
  these cannot prove the visible guide matches the actual split.

**Gap / owner:** O2/R1 own the actual guide/split and membership regression.
The mounted pointer gesture must establish ink AND text membership, guide
placement, one-step undo/redo, and cancel restoration without assuming the split.

### Compatibility after existing ink; second-device JSON arrival

- `src/persistence/InkFolder.test.ts`: synthetic adapter migration, collisions,
  hold/settle/move/repoint/persist order, failure cleanup, and folder discovery
  without synced plugin settings. No settings UI or second device runs here.
- `src/ChangeInkFolderWiring.test.ts`: executes the extracted production
  `changeInkFolder` body and inspects callback wiring. The `changeFolder`
  collaborator is deliberately faked; callback ordering is tested separately.
- `src/persistence/PageStore.test.ts`: real store with fake files, both-way
  folder fallback and “a sidecar arriving after this device wrote blind takes
  the page over.” That case writes local ink again after arrival, checks one live
  sidecar and preserved conflict bytes. It does not prove spontaneous visible
  adoption in an already-open note or PDF.
- `src/inline/InlineInkStore.reload.test.ts`: directly invokes store reload with
  a fake host, checks content and lock/damage/empty guards. Its header explicitly
  excludes the poll and gesture gates. Assertions on renderable content are not
  observed pixels.
- `src/pdf/PdfInkReload.test.ts`: directly exercises `reloadExternal` against a
  fake host. Treat as method coverage; the production coordinated poll is tested
  separately in `src/PdfSharedReload.test.ts` using real PageStore/PdfInkStore,
  fake files/controllers and an extracted registered poll. Refresh callbacks
  stand in for an actual PDF viewer. `LiveReloadIsolation.test.ts` checks that
  registered poll's surface isolation/backoff with collaborators faked.

**Gap / owner:** O1 assigns a future complete workflow only once. Neither the
settings toggle through existing note/PDF ink nor two actual devices with the
document arriving before its JSON is covered end to end. A store fallback pass
cannot close the device appearance/continued-edit/reopen acceptance requirement.
Also, `check:compat` runs `ReviewCompatibility.test.ts` (Obsidian API/source
rules); its name does not mean sync compatibility was tested.

## Candidate acceptance record

Generate a pending template without modifying any candidate:

```powershell
python scripts/check-release-acceptance.py --template > acceptance.json
```

Fill `candidate.receipt` with the exact package receipt path and the independently
supplied SHA256. Do not recompute a changed receipt's expected hash to force PASS.
Fill all ten scenarios; no omitted, duplicate, unknown, pending, failed, or
relayed-only scenario can pass. Keep automated results in the package receipt,
never relabel them as measured device observations.

For each device, `identity` references a hashed JSON file with this shape:

```json
{
  "kind": "device-identity",
  "evidenceLevel": "measured",
  "device": "actual device name",
  "vault": "actual disposable vault name or path",
  "source": "full candidate commit",
  "assets": {"main.js": "sha256", "manifest.json": "sha256", "styles.css": "sha256"},
  "runtimeReloaded": true,
  "observedAt": "2026-09-12T12:00:00Z",
  "evidence": [{"path": "device-build-and-reload-evidence.txt", "sha256": "sha256"}]
}
```

This is a shape example, not device evidence. Capture installed asset identity
and a confirmed plugin reload BEFORE the scenario. A local source checkout,
version label, copied file, or assumed sync completion is insufficient. Record
the operator/build verification and reload evidence; the checker cannot observe
the running device itself. For sync scenarios the source and target must be
distinct devices, both with matching candidate identities. Describe the sync
transport and actual vaults in the evidence.

Every scenario needs timestamp, exact template settings, measured observations,
and nonempty hashed evidence (recording/trace or an operator's exact actions and
observations). Three means at least three cycles; preserve the template setting
`minimumCycles: 3` and record the performed count in the evidence. Every path,
including paths inside device identity JSON, is relative to `acceptance.json`'s
directory or an absolute local path. Evidence must contain no credentials or
real user ink. Use synthetic notes and PDFs.

Run the companion checker, pointing to O1's existing checker and using the exact
combined gate names required for this release (examples below; no gate aliases
are inferred):

```powershell
npm run check:release-acceptance -- acceptance.json --receipt-checker C:/Users/alanl/.claude/coordination/tools/check_receipt.py --repo C:/Users/alanl/slate --require-gate versions --require-gate site --require-gate typecheck --require-gate unit --require-gate render --require-gate build
npm run test:release-acceptance -- --receipt-checker C:/Users/alanl/.claude/coordination/tools/check_receipt.py
```

The checker reruns the existing receipt verifier in combined mode, pinned to the
receipt hash. That verifier owns source/tree, assets, review, and gate integrity;
this script only adds scenario evidence rules and compares device identities
with its verified results. It does not alter the shared coordination tools.
Exit 0 means recorded evidence is complete and consistent. It cannot establish
that an operator's claim is true, interpret a video, or approve publication.
Exit 1 means incomplete/failed validation; exit 2 means invalid CLI arguments.

## Device actions (O1 presents one at a time)

1. On the exact candidate, place synthetic fixed ink beside text. Scroll both
   ways with Readable line length OFF, then ON. Capture motion and settling.
   Fail on any transient separation, even if it snaps back afterward.
2. At each of 10%, 100%, and 400%, repeat zoom/draw/return three times. Verify
   new ink lands under the tip, old ink stays registered, undo/redo works, and
   cold reopen retains alignment. Capture intermediate frames as well as rest.
3. Drag Insert Space through and between synthetic words/text rows. Compare
   guide and actual split, moved and unmoved ink/text membership, undo/redo,
   then cancel a separate drag and verify original content is restored.
4. For a synthetic note and PDF separately, enable compatibility AFTER drawing.
   Verify existing ink, continued edit and cold reopen on both devices. Then
   run a separate late-arrival case: open the document on device two before its
   JSON arrives, deliver JSON, verify visible ink and cold reopen. Check that
   subsequent edits do not fork divergent live sidecars. Preserve any recovery
   copies; never delete user data as part of a test.
