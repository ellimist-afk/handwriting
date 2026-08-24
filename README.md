# Handwriting

Pen ink on ordinary Markdown notes in Obsidian.

Open a note in Live Preview, put the pen down, write. The note stays a normal
`.md` file. The ink lives beside it, in a JSON sidecar under `.handwriting/`,
drawn over the editor on a layer that extends below and to the right of the
text. The only change to the Markdown is one frontmatter property, and only
on notes you've actually inked.

Handwriting v0.13.10 is free and open source. The complete buildable source is
this repository, licensed `AGPL-3.0-only`. No payment, no account, no license
key, no telemetry, nothing that touches a network.

## requirements

Desktop Obsidian 1.13.7 or newer, and an active pen digitizer. An older
Obsidian refuses to load the plugin rather than misbehaving.

Built and tested on a Surface with a Surface Pen. Other Windows pen devices
should work but nobody's tested them yet.

Desktop only, and the manifest says so. Handwriting draws from
`pointerrawupdate`, which iOS WebKit doesn't implement, and reads Electron
APIs for its diagnostics.

## installing

Three files go into a plugin folder inside your vault.

1. Create `<vault>/.obsidian/plugins/handwriting/`. `.obsidian` is hidden;
   type the path if your file manager won't show it.
2. Copy `main.js`, `manifest.json` and `styles.css` into it.
3. In Obsidian: Settings, Community plugins, reload the plugin list if it was
   already open, enable Handwriting.

Take the three files from a release, or build them yourself with the steps
below.

## updating

Replace all three files from the same release, then reload Obsidian or
disable and re-enable Handwriting under Community plugins.

The three files are one unit. `main.js` is the code, `styles.css` carries
rules the code relies on, and `manifest.json` declares the version and the
minimum Obsidian the other two expect. Copy only `main.js` and the old
stylesheet stays behind, and what breaks looks like an input bug, usually
pen strokes dying over embedded blocks like the backlinks pane.

Your ink lives in the vault, so updating never touches it.

## what the pen does

The tip inks. The eraser end erases. The barrel button lassos: hold it and
circle some ink, then drag the selection to move it or press Delete to
remove it.

Two tools, pen and highlighter, each with three nib sizes (fine, medium,
bold) and its own small palette: six pen inks, five highlighter colors. All
of it's in the command palette and bindable to hotkeys. Worth binding:
`Pen`, `Highlighter`, `Ink size: next`, `Ink color: next`. Size and color
apply to whichever tool is active, and persist across sessions.

Ink follows the text. It scales with Obsidian's zoom (Ctrl +/-, Ctrl-scroll
quick font size, pinch), stays glued to the text while you scroll, and plain
Ctrl+Z undoes ink and text edits in the order they happened. The surface
isn't bounded by the text. Draw below the last line or far off to the right
and the note grows scroll room to reach it.

To wipe a note, run `Delete all ink on this note`. It asks first, copies the
ink to the trash described below, and one undo brings everything back.

Only the pen draws. But keeping the pen reliable takes some arbitration of
touch, and a brief suppression of mouse events, so here's what happens to
the other two.

The mouse is never a drawing input, and Handwriting adds no mouse behaviour.
It does suppress the mouse-compatibility events Windows synthesizes from a
pen contact, during a claimed stroke and for 350 ms after it, so an eraser
pass can't drag the text caret. Outside that window the mouse is untouched.

Touch stays the editor's, with one piece of arbitration Handwriting owns. A
pen contact must never be mistaken for a scroll, so the editor's scroller
sits at `touch-action: none` whenever a pen could appear. Under that setting
the browser won't pan for a finger either, so Handwriting carries the first
finger gesture itself: it scrolls the note 1:1 with the finger, and on
release it glides, decaying exponentially with a 325 ms time constant.
The curve is Handwriting's own, so the first swipe after the pen has been
near may not feel identical to a native one. Once that
gesture ends with a real pan, native finger scrolling comes back for the
next second, and any pen signal takes it away again. A finger tap places the
caret as usual.

Palm rejection: a new finger contact is swallowed, so a resting hand neither
scrolls nor moves the caret, whenever any one of three things is true. A pen
stroke is in progress; the last pen contact ended under 250 ms ago; or the
pen was last seen hovering under 300 ms ago. The two tails run from
different events and overlap, and the hover one usually decides it: a pen
lifting away passes back through hover range, and each hover sample restarts
that 300 ms afresh, so touch stays blocked until the pen is clear of the
glass. The 250 ms tail only covers the pen leaving hover range outright.

A swallowed contact that travels far enough within its first 400 ms is
released and becomes a scroll, so you can still flick with a finger while
holding the pen. A contact the pen overlapped at any point stays a palm for
as long as it's down.

## where the ink is

One JSON file per note, in `.handwriting/` at the vault root, named by the
note's `handwriting-page-id`. That id is the one frontmatter property
Handwriting adds, on the first stroke only, and it's hidden from the
Properties panel. Rename or move the note and nothing changes: the id
travels with the file and the sidecar is keyed by the id.

Everything Handwriting writes stays inside your vault, plus its own settings
file, `data.json`, in the plugin folder. Nothing is sent anywhere.

`docs/storage.md` has the format, the save timing and every recovery path in
detail. The short version:

Handwriting writes through Obsidian's file adapter into `.handwriting/` at
the vault root. That's a hidden folder, and not every sync or backup tool
includes hidden folders by default. Check that yours carries `.handwriting/`.
If it doesn't, the ink won't make it into your backups or onto your other
machines.

A save runs 700 ms after the most recent change, with a five-second ceiling
so continuous writing can't defer it forever. Writes go to a temporary file
and get renamed into place, so an interrupted save is recoverable.

Deleting a note moves its ink into `.handwriting/trash/` instead of deleting
it, when Obsidian reports the deletion while Handwriting is loaded. Every
copy into the trash gets its own timestamped file, nothing there is ever
overwritten, and Handwriting never empties that folder.

A sidecar changed by another program or device is never overwritten: the
other version is preserved beside it and you're told. A sidecar that can't
be parsed is left alone and the note opens read-only for ink, so a backup
can still repair it.

Back up the vault the way you already do, and confirm `.handwriting/` is in
the backup. The atomic-write scheme handles an interrupted save. A dying
disk needs a real backup.

## the canvas

A note with `handwriting: page` in its frontmatter opens in a dedicated
canvas view instead of the editor: its own toolbar, free-placed text boxes,
images as vault attachments, a pannable camera. The ribbon's **New canvas
page** button creates one, and `Open canvas page as Markdown` opens it in
the plain editor for the rest of the session; it goes back to the canvas
next time unless you remove the `handwriting: page` line.

The canvas shares the ink engine and the sidecar format with the inline
surface, but a note's ink belongs to one surface or the other: ink drawn on
the canvas isn't shown in the editor, and the editor won't write over a
canvas page's file.

It predates inline ink and is still supported. The inline surface is where
the work goes.

## limitations

Ink draws in the Markdown editor, in Live Preview and source mode. Reading
View and exports show the text without ink.

Undo history for ink is per pane and clears when the note is closed.

A quit before a pending write lands loses what that write was carrying.
Handwriting flushes on unload, but Obsidian doesn't wait for that flush, so
don't count on it.

Don't open the same canvas page in two panes. The canvas still uses per-view
snapshots, so the last pane to save can replace changes from the other one.
Ordinary Markdown notes with inline ink use a shared record and don't have
this problem.

Tested on Windows pen hardware. Reports from other devices are welcome.

## building and testing

Node 18 or newer.

```
npm ci            # install the locked dependency set
npx tsc -noEmit   # typecheck
npm test          # the full test suite
npm run build     # typecheck, then a production main.js
```

`npm run build` is the build command Obsidian's scanner selects. It writes
`main.js` next to `manifest.json` and `styles.css`, which are the three
files a release carries.

`npm run release` is the packager used to cut a release. It refuses to write
anything unless the worktree is clean, the versions agree across
`manifest.json`, `package.json` and `versions.json`, and every stylesheet
rule the code depends on is present. It writes a receipt with the commit and
the SHA-256 of each asset.

## reporting problems

Bugs and feature requests go to
https://github.com/ellimist-afk/handwriting/issues

Say what you did, what happened, and, for pen problems, which device and pen
you have. If you can reproduce it, run `Diagnostics: toggle recording`,
reproduce, then `Diagnostics: copy pen trace` and paste the result in.

For a security defect, don't open a normal issue. Use GitHub private
vulnerability reporting on this repository. `SECURITY.md` has the details.

## contributing

Contributions are welcome, under `AGPL-3.0-only`. `CONTRIBUTING.md` lists
the checks to run before opening a pull request. There's no contributor
license agreement and no copyright assignment.

## license

Handwriting code owned by Alan is licensed under the GNU Affero General
Public License, version 3 only (`AGPL-3.0-only`). The full text is in
`LICENSE`.

Anyone may use, inspect, modify and redistribute it under those terms. If
you distribute a modified version, you must provide the corresponding source
and keep it under the same license.

Nothing from `node_modules` is bundled into `main.js`. The build marks
`obsidian`, `electron` and the CodeMirror and Lezer packages as external,
because Obsidian provides them at runtime, so the shipped `main.js` contains
only Handwriting's own code. The build and test dependencies keep their own
licenses and are not redistributed here.

`TRADEMARKS.md` covers naming and endorsement for forks and modified
distributions. It claims no trademark and restricts nothing the licence
grants.

## money

Handwriting is free. If you want to chip in anyway:
https://ko-fi.com/ellimistafk
