# How the Handwriting source is laid out

A map of `src/` for someone reading the plugin for the first time. It says what
each folder is for and names the files to open first. Where this document and the
code disagree, the code is right. A test (`test/ArchitectureDoc.test.ts`) fails
when a folder under `src/` has no section here, so the list of folders stays
complete; the wording is checked by people.

Handwriting draws pen ink over ordinary Markdown notes in Obsidian. The note stays
a normal Markdown file. The ink is kept in a separate JSON file beside the vault's
other data, and the plugin draws it on a canvas laid over the note. The same
engine also inks PDFs and the core Slides presentation. Nothing in the plugin needs
a network. The one thing that can send data out is the bug-report Upload button,
described at the end.

Most files are small and named for one job. Where a class grew past a thousand
lines it was split by installing groups of methods onto its prototype (see the
`Install` functions listed under `main.ts` below), so a name such as
`InkOverlayPenPath.ts` or `PageStoreWrite.ts` is a slice of the class named by its
prefix, not a separate component.

## Folders

### `src/`

The plugin entry point and the files that wire it together. `main.ts` defines the
plugin class and its `onload`; `PluginOnload.ts` and `PluginOnloadReload.ts` hold
the phases `onload` runs; `PluginApply.ts` applies settings to the live surfaces;
`PluginLifecycle.ts` holds `onunload` and the shutdown flush; `CommandPaletteSplit.ts`
decides which commands are always listed and which are opt-in; `OwnedNotices.ts`
keeps one message on screen per topic. `CodeOnly.ts` is a helper for tests that
read source text. The many `*.test.ts` files at this level check that the pieces
above are wired together and that user-facing wording stays fixed.

### `src/camera/`

The camera: the pure coordinate maths between the page and the screen, and a small
mutable wrapper that announces changes. `coordinates.ts` has the conversions and
`Camera.ts` holds the current zoom and offset for a surface. Nothing here touches
the DOM.

### `src/commands/`

Every command the plugin registers in the command palette, in three files so none
grows too large. `RegisterCommands.ts` has the pen, tool and note commands,
`RegisterExportCommands.ts` the export, PDF and selection commands, and
`RegisterDiagCommands.ts` the bug-report and diagnostics commands, including the
only network call in the plugin.

### `src/diag/`

Diagnostics, all off until the person turns recording on. `DiagSwitch.ts` is the
master switch for recording, `InkTrace.ts` records a browser performance trace of
the ink path, `UndoHistoryTrace.ts` records undo behaviour, `Raster.ts` checks that
ink is rasterised at the display's resolution, and `PlatformCapabilities.ts` reports
what the device can deliver to the pen path. `DiagnosticTextModal.ts` is the window
that shows a finished report with its Copy, Save to vault and Upload buttons.

### `src/export/`

Turning ink into files. `Snips.ts` makes the image snip of ink or of a PDF region,
the numbered export names and the flattened PDF copy; `CreateFreshFile.ts` picks a
free file name and creates the file without two exports colliding.

### `src/ink/`

The ink itself, independent of where it is drawn. `Stroke.ts` is the data model
(coordinates are page coordinates); `StrokeBuilder.ts` turns pen samples into a
stroke; `Smoothing.ts`, `Prediction.ts` and `ShapeSnap.ts` smooth, predict and snap.
`StrokeRenderer.ts`, `Ribbon.ts`, `RibbonRenderer.ts`, `WetInkRenderer.ts` and
`TailRenderer.ts` draw strokes, both the stroke still being written and the
finished ones. `Eraser.ts` is whole-stroke hit testing and `StrokeIndex.ts` a
spatial index over a note's strokes. `InkPdf.ts` exports ink as a PDF,
`InkPdfAppend.ts` adds ink to a PDF someone else wrote, `SvgExport.ts` writes it as SVG, and `DeleteAllInk.ts` is the
delete-everything flow with its backup. `InkPresets.ts` holds the quick pens.

### `src/inline/`

The note surface, which is the main product: ink drawn on an ordinary Markdown note
in the editor and in reading view. `InkOverlay.ts` is the CodeMirror extension that
mounts a canvas over each note, and the files starting `InkOverlay` are slices of it
(pen path, lifecycle, camera, erase, pinch, layout, repaint). `InlinePenRouter.ts`
and its slices capture pointer events, so the pen inks while touch pans and pinches.
`InlineInkStore.ts` and its slices keep a note's ink in memory and talk to the
persistence layer. `InlineClaim.ts` writes the one frontmatter line the plugin ever
adds to a note. `EmbedInk.ts` draws the same ink in reading view and embeds,
`LineAnchor.ts` keeps ink beside the text line it was drawn next to, and
`MobileTools.ts` is the floating pen strip. `WheelZoom.ts`, `NoteCamera.ts`,
`NotePaper.ts` and `CanvasNoteOverride.ts` handle zoom, per-note view memory, paper
styles and the per-note Infinite Canvas choice.

### `src/input/`

Pointer handling shared by the surfaces. `PointerRouter.ts` sends each pointer event
to the right behaviour by device and defines the `PenSample` type used everywhere.
`PalmGate.ts` and `PalmShield.ts` reject palm touches, `ManipulationGuard.ts` keeps
the browser from taking a pen drag for a scroll, `Fling.ts` carries pan momentum,
`MouseTrail.ts` smooths whole-pixel mouse input, and `PenDiagnosticsView.ts` is the
pen diagnostics view.

### `src/model/`

The shape of a page, with no DOM and no file access. `PageData.ts` is the data that
goes in the ink sidecar (strokes, text boxes, images, paper); `MarkdownPage.ts`
reads and updates the Markdown side, including the frontmatter keys;
`PageDocument.ts` owns a page's canonical content; `PageJoin.ts` joins the text half
and the sidecar half; `PageMigrate.ts` decodes older or damaged sidecars and reports
what had to be dropped; `PageIdIndex.ts` tracks which note owns which page id.

### `src/objects/`

Selection. `Selection.ts` is the lasso geometry in page coordinates and
`SelectionModel.ts` decides what a lasso selects. Both are free of the DOM so they
work the same on every surface.

### `src/pdf/`

Ink on PDFs. `PdfIdentity.ts` gives a PDF an id taken from its content, since a PDF
cannot carry a property; `PdfInkStore.ts` loads and saves a PDF's ink; and
`PdfInkController.ts` with the `PdfInk*` files is the controller that keeps one ink
canvas per visible page in step with Obsidian's PDF viewer (`PdfViewerProbe.ts` is
every place the plugin touches that viewer). `PdfClaims.ts` records which sidecar a
PDF pane draws into. `PdfSyntax.ts`, `Flate.ts` and `Sha256.ts` are the small PDF
parser, decompressor and hash used to read a PDF's structure and add ink to it
without a library.

### `src/persistence/`

Reading and writing the ink sidecars safely. `PageStore.ts` is the store, and
`PageStoreLoad.ts`, `PageStoreWrite.ts`, `PageStoreSchedule.ts`, `PageStorePaths.ts`,
`PageStoreAdopt.ts` and `PageStoreRemove.ts` are its slices: loading and recovery,
the queued write with retries, save timing, file paths, adopting a change made
outside the plugin, and removal into the trash. `PageIdentity.ts` is the startup
census of page ids and the handling of duplicates, `InkFolder.ts` moves the ink
folder, `ForkResolution.ts` and `ForkResolutionModal.ts` let a person choose between
two diverged copies, and `PageMerge.ts` and `SplitInk.ts` merge two revisions and
find ink that ended up in two folders. `FakeAdapter.ts` is an in-memory vault for
tests.

### `src/settings/`

The settings page and the saved settings. `SettingsModel.ts` is the shape and the
defaults, `PluginSettings.ts` loads, merges across devices, debounces and applies
them, and `HandwritingSettingTab.ts` is the settings page itself.

### `src/site/`

`DemoInk.ts` runs the plugin's own stroke code on the project web page in `docs/`,
so the demo there draws with the real pipeline and not a copy of it.

### `src/slides/`

Ink on the core Slides presentation. `SlidesInkSurface.ts` is the surface and the
`Slides*` files are slices of it: mounting over the presentation, the pointer path,
palm and pen guards, persistence, and `SlidesSections.ts`, which matches a note's
Markdown to the presenter's slides. `SlidesController.ts` turns the surface on and
off.

### `src/update/`

`WhatsNew.ts` holds the release notes shown once after an update. They are part of
the build, so the popup works offline.

### `src/util/`

Four small helpers: `Detached.ts` starts work the caller cannot await,
`MarkdownPath.ts` says whether a path is a note, `RuntimeScheduler.ts` gives timers
and animation frames for the right window, and `DeleteAllBackupNotice.ts` words one
notice.

### `src/view/`

Chrome and views that are not a drawing surface. `HeaderActions.ts` puts the canvas
and paper buttons in a note's header, `Notices.ts` shows multi-paragraph notices as
separate blocks, and `PenLabView.ts` is a small test surface with nothing but the
stroke pipeline, kept for measuring.

### `src/testUtils/`

Helpers shared by tests only, never imported by the plugin: `fakeDom.ts` is a
minimal browser stand-in for tests that run real production code,
`LiveReloadTestHarness.ts` runs the real live-reload registration, and
`ReticleShown.ts` reads whether a test rig's pen cursor is visible.

### `src/__audit__/`

Regression tests only, one file per defect found in a review of the code, each named
for the defect, for example `A1-2-ink-during-load-font-ref.test.ts`. Each drives the
real production code on a minimal rig and fails if the defect comes back.

## Data flow

A stroke on a note goes through these steps.

1. `InlinePenRouter.ts` (in `src/inline/`) receives the pointer events. A pen goes to
   ink; touch goes to pan and pinch in `InlinePenRouterNav.ts`. Each pen event
   becomes a `PenSample` (`src/input/PointerRouter.ts`), including the coalesced
   samples the browser batches between frames.
2. The overlay (`InkOverlayPenPath.ts`) feeds the samples to `StrokeBuilder` in
   `src/ink/`. While the pen is down the stroke is drawn on a small wet canvas by
   `WetInkRenderer.ts`, with a short predicted tail from `TailRenderer.ts`.
3. When the pen lifts, the stroke is committed to the note's ink in memory by
   `InlineInkStoreCommit.ts`, and the finished stroke replaces the wet drawing on
   the committed canvas.
4. `InlineInkStorePersist.ts` schedules a save. It goes through the host given to
   `attachHost` in `PluginOnload.ts` to `PageStore` (`src/persistence/`), which
   waits for a quiet moment or a maximum delay, holds the write while a pen is down,
   and writes the sidecar.
5. On the first stroke in a note, `InlineClaim.ts` first writes the page id into the
   note's frontmatter, because the sidecar is named by that id.

Opening a note runs the other way: the id is read from the frontmatter,
`PageStore.load` reads the sidecar, `PageMigrate.ts` decodes it, and the ink is
painted. If the sidecar changes on disk from outside, for example a sync from
another device, `PageStoreAdopt.ts` keeps a copy of both revisions before the new
one is adopted, and `ForkResolution.ts` lets the person choose when they diverge.

PDFs and Slides use the same ink code with their own host: `src/pdf/` identifies a
PDF by content and draws one canvas per page, and `src/slides/` draws over the
presentation. Exports (`src/export/`, `src/ink/InkPdf.ts`, `src/ink/SvgExport.ts`)
read the same stroke data and never change it.

## Ink storage

The Markdown file holds only your text and one frontmatter property,
`handwriting-page-id`, written on the first stroke. A note you never ink is never
changed. The ink is one JSON file per note, by default in a `.handwriting/` folder at
the vault root (the folder is a setting, and `src/persistence/InkFolder.ts` moves it
without losing ink), named by that id, so renaming or moving the note keeps its ink. A save is
written to a `.tmp` file and renamed; the previous copy of a deleted note's ink is
kept in `.handwriting/trash/`. A PDF's ink is stored the same way, under an id
derived from the PDF's first 64 KiB and its length, because a PDF has nowhere to
keep a property and the plugin never writes into one.

The per-note paper and Infinite Canvas choice live in the sidecar, not in the
properties. Notes from earlier versions may still carry `handwriting-paper` or
`handwriting-canvas` lines; they are still read, and each is removed the next time
the choice is changed on that note. `docs/storage.md` is the longer account of the file layout, identity and
recovery.

## `main.ts`

`main.ts` defines `HandwritingPlugin` and its `onload`. At the bottom it installs
the method groups from other files onto the class (`installPluginSettings`,
`installPluginOnload`, `installPluginLifecycle`, `installRegisterCommands` and the
rest), which is how the class stays readable. `onload` then runs, in order:

1. `onloadDevice`: sets up the per-device stores, in this device's local storage and
   never in the synced `data.json`: pressure calibration, the latch that says a pen
   has been seen, and the side-button choice.
2. `onloadStore`: creates the `PageStore`, gives it this device's install id, and
   sets the notices for failed writes and for conflict copies.
3. `loadSettings`: loads `data.json`, merges another device's saved settings, and
   attaches the PDF host.
4. `onloadViews`: registers the pen lab view, attaches the host of the shared inline
   ink store, starts the per-note canvas choice and registers the editor extension
   that mounts the ink overlay in every note.
5. `onloadEmbeds`: ink in reading view and embeds.
6. `onloadNoteChrome`: the header buttons, the file menu entries, the settings tab.
7. `onloadLiveReload`: reloading a note's ink when its sidecar changes elsewhere.
8. `registerCommands`: every command.
9. `onloadVaultEvents`, `onloadWorkspace`: rename, delete and layout events, which
   start and stop the PDF and Slides surfaces.
10. `onloadFlushAndForeground`: flushes pending saves when the app is hidden.
11. `onloadPageIdWatch`: the page id census, run when Obsidian's metadata is ready.

`onunload` in `PluginLifecycle.ts` stops any recording, clears session memory and
flushes pending writes. `main.ts` also holds the one constant for the upload
address, `TRACE_UPLOAD_URL`.

## Upload

The Upload button is in the bug-report window and nowhere else. This section is
written from the code that does it; it is documentation, not telemetry.

**Nothing leaves without the press.** Recording is off at the start of every
session (`src/diag/DiagSwitch.ts`: the switch is a module variable that starts
false and is not saved). While it is off, the code that collects pen events returns
before storing anything. A person starts recording with the command "Bug report:
record". The command "Bug report: send" stops the recording and opens a window
(`src/diag/DiagnosticTextModal.ts`) that shows the report. That window has
"Upload to developer", "Copy" and "Save to vault" buttons. Copy and Save to vault
never use the network. Only a click on "Upload to developer" runs the upload
function; opening the window, recording, or closing it sends nothing.

**What is sent.** The recording, as JSON, built by `captureInlinePenTrace` in
`src/inline/InlinePenRouterTrace.ts` and assembled in `RegisterDiagCommands.ts`
under the "Bug report: send" command. Below is every key the body can contain, by
the name it has in the JSON; each is a field of the types in those files.

The top level has `v` (the format number, 1), `env`, `events`, `traceMeta` and
`analysis`.

- `events`: one row per pointer event, with `t` (time), `type`, `id` (pointer id),
  `ptr` (pointer type), `buttons` (held), `button` (the one that changed),
  `pressure`, `x` and `y` (position in the window), `tx` and `ty` (pen tilt), `note`
  (a short text written by the code, for example `coalesced=4`), `eventId`, `epoch`
  (the recording number), `role`, `sourceT` and `observationT` (times). A row may
  also have `cs`, the coalesced samples the ink used, each with `t`, `x`, `y` and `p`
  (pressure), and `partial` and `termination` (a partial batch, a silent lift). The
  tag, id and CSS classes of the element an event hit can appear inside a `note`
  (`describeEl` in `src/inline/PenHitProbe.ts`); an element's text never does.
- `traceMeta`: `evictedRows`, `evictedSamples`, `retainedRows`, `retainedSamples`,
  `truncated` and `partialBatch`. Counts and two flags about the recording itself.
- `analysis`: figures computed from `events`, with no new data. At the top:
  `available`, `reason` (one fixed sentence, present only when the analysis was not
  possible), `incomplete`, `truncated`, `partialBatch`, `evictedRows`,
  `evictedSamples` and `epochs` (the recording numbers). `streams` has one entry for
  each of `pointermove` and `pointerrawupdate`, with `parentCount`, `sampleCount`,
  `coalescedParentCount`, and `sourceSpacing` and `observationSpacing`, each with
  `count`, `min`, `max` and `mean`. `contacts` has one entry per pen contact, named
  by the recording number, pointer id and a serial, with `epoch`, `pointerId`,
  `incomplete`, `streams` (the same two names, each with `parentCount` and
  `sampleCount`) and `lifecycle`, a list of rows with `type`, `sourceT`,
  `observationT`, `x`, `y` and `pressure`.
- `env`, the device and settings: `loadedBuild` (`version`, `sourceCommit`,
  `sourceTree`, `dirtyStatus`, `verified`: the plugin version and the identity of the
  build, where `sourceTree` is a hash of the build inputs), `host` (one text of host
  flags from Obsidian's `Platform`), `os` (the operating system name), `dpr` (the
  pixel ratio), `viewport` (`w` and `h`, the window size), and `settings`:
  `inkSmoothing`, `strokePrediction`, `booxMode`, `pressureSensitivity`, `mouseInk`,
  `mouseInkLive` (mouse ink as stored and as live), `eraserMode` and
  `eraserRadiusPx`.
- `env.undoHistory`, the undo trace (`src/diag/UndoHistoryTrace.ts`): `v`, `status`
  (not recorded, armed with no key, captured or discarded), `epoch`, `gestures` (the
  undo and redo gestures seen), `endReason`, `truncated`, `droppedRecords` and
  `records`. A record has `seq`, `t`, `phase`, `windowToken` and `instanceToken`
  (a prefix and a counter that tell windows and editors apart), and, depending on
  the phase, `kind` (undo or redo), `key` (`key` as z or y, `ctrl`, `meta`, `shift`,
  `alt`, `defaultPrevented`, and `target` as editor, toolbar or other), `selection`
  (`from`, `to`, `anchor`, `head` as character offsets, and `empty`), `scroll` (`x`,
  `y`, `phase` as before or after, and `axes`), `transaction` (`sequence`, `count`,
  `userEvent` as undo, redo or other, `docChanged`, `inkEffectCount`,
  `foreignEffectCount`) and `guard` (`decision`, `stage` and `reason`). Offsets and
  counts, never the characters at them.

**What is not sent.** No note text, file name, file path, page id or vault content.
The report never reads them: none of the trace code is given a note's text or path.
The window says the same in its own words: "pen coordinates, timing and device
info, never your note text".

**Where it goes.** One request, made with Obsidian's `requestUrl` in
`RegisterDiagCommands.ts`: a `POST` of the JSON to `TRACE_UPLOAD_URL` + `/upload`,
where `TRACE_UPLOAD_URL` is the constant in `src/main.ts`
(`https://handwriting-traces.trace-worker.workers.dev`). It is the only network call
in `src/`. If the constant is the empty string the Upload button is not built at all.
The reply must be status 200 with an id, which the window shows so the person can
quote it; otherwise the window reports a failed upload, and a request with no reply
is given up after 30 seconds. One recording is uploaded once per window.

**The receiving end.** `scripts/trace-worker/worker.mjs` is the small Cloudflare
Worker that answers. It accepts only a body that parses as a version 1 capture and
is under 4 MB, limits one address to 30 uploads an hour (the address is used for
that counter, which expires after an hour), stores the JSON under a random id for 30
days, and lets only the developer read a recording back, with a secret key. The
worker deployed at that address cannot be verified from this repository; the file
above is the source it is deployed from.
