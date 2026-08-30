# the Handwriting manual

Everything that used to be on the front page. Updating, what the pen does to
touch and mouse, where ink lives, the canvas, limitations, building from
source. For the sidecar format and every recovery path, see
[storage.md](storage.md).

## updating

Replace all three files from the same release, then reload Obsidian or
disable and re-enable Handwriting under Community plugins.

`main.js`, `styles.css` and `manifest.json` ship together and have to move
together. Copy only `main.js` and the old stylesheet stays behind, and what
you get looks like an input bug, so you go hunting in the wrong place.

Updating never touches your ink, which lives in the vault.

## turn off backlinks in document

Settings > Backlinks > **Backlinks in document**, off.

On a tablet that panel sits right where your hand rests, and every row in it
is a link a stray finger can set off. The pen itself won't trigger them.
Backlinks still work from the sidebar.

## what the pen does

The tip inks. The eraser end erases. The side button lassos: hold it and
circle some ink, then drag the selection to move it or press Delete to
remove it.

Two tools, pen and highlighter, each with a nib size slider and its own small
palette of eight pen inks and five highlighter colors. All of it is in the
command palette and bindable to hotkeys. Worth binding: `Pen`, `Highlighter`,
`Ink size: next`, `Ink color: next`. Size and color apply to whichever tool is
active, and persist across sessions.

Ink stays glued to the text while you scroll and scales with Obsidian's zoom
(Ctrl +/-, Ctrl-scroll quick font size, pinch). Plain Ctrl+Z undoes ink and
text edits in the order they happened. Draw below the last line or far off to
the right and the note grows scroll room to reach it.

To wipe a note, run `Delete all ink on this note`. It asks first, copies the
ink to the trash described in [storage.md](storage.md), and one undo brings
everything back.

Only the pen draws. Touch and mouse keep working the way they do everywhere
else in Obsidian, with a few exceptions that exist to keep the pen reliable.

While the pen is writing, or has just been near the glass, a new finger
contact does nothing at all, which is what keeps a resting hand from dragging
the page out from under you. Move that finger far enough and it gets released
as a scroll anyway, so you can still flick the page while holding the pen.

A pen contact must never be read as a scroll, so while the pen is around
Handwriting carries the first finger scroll itself, on its own glide curve.
The first swipe after the pen has been near may not feel quite like a native
one, and native scrolling returns a second later.

On Windows a pen contact also raises synthetic mouse events. Those are
suppressed during a stroke and briefly after it, so an eraser pass cannot
drag the text caret.

## where the ink is

One JSON file per note, in `.handwriting/` at the vault root, named by the
note's `handwriting-page-id`. That id is the one frontmatter property
Handwriting adds, on the first stroke only, and it's hidden from the
Properties panel. Rename or move the note and nothing changes, because the id
travels with the file and the sidecar is keyed to it.

Everything Handwriting writes stays inside your vault, plus its own settings
file, `data.json`, in the plugin folder. Nothing is sent anywhere.

[storage.md](storage.md) has the format, the save timing and every recovery
path in detail. The short version:

Handwriting writes through Obsidian's file adapter into `.handwriting/` at
the vault root. That's a hidden folder, and not every sync or backup tool
includes hidden folders by default. Check that yours carries `.handwriting/`.
If it doesn't, the ink won't make it into your backups or onto your other
machines.

Saves are written to a temporary file and renamed into place, so an
interrupted save is recoverable.

Deleting a note moves its ink to `.handwriting/trash/` instead of deleting it.
Handwriting never overwrites or empties that folder, so clearing it out is
your job.

If another program or device changes a sidecar, Handwriting keeps that
version beside its own and tells you, rather than overwriting anything. A
sidecar it can't parse is left alone, and the note opens read-only for ink so
a backup can repair it.

Back up the vault the way you already do, and confirm `.handwriting/` is in
the backup.

## the canvas

A note with `handwriting: page` in its frontmatter opens in a dedicated
canvas view instead of the editor, with its own toolbar, free-placed text
boxes, images as vault attachments and a pannable camera. The ribbon's **New canvas
page** button creates one, and `Open canvas page as Markdown` opens it in
the plain editor for the rest of the session; it goes back to the canvas
next time unless you remove the `handwriting: page` line.

The canvas shares the ink engine and the sidecar format with the inline
surface, but a note's ink belongs to one surface or the other. Ink drawn on
the canvas doesn't show up in the editor, and the editor won't write over a
canvas page's file.

It predates inline ink and is still supported, though the inline surface is
where the work goes now.

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

Tested on a Microsoft Surface with a Surface Slim Pen 2. Reports from other
devices are welcome.

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

Contributions are welcome under `PolyForm-Strict-1.0.0`. [CONTRIBUTING.md](../CONTRIBUTING.md)
lists the checks to run before opening a pull request. For a security
defect, don't open a normal issue; [SECURITY.md](../SECURITY.md) has the
private reporting path.

## license details

Handwriting is free and open source, under PolyForm Strict 1.0.0 plus a
grant covering personal use and internal business use, including work you get
paid for. You may not redistribute it, publish a modified version, or ship it
inside something you sell. For those, ask. The full text is in
[LICENSE](../LICENSE).

Releases up to and including 1.3.8 went out under `AGPL-3.0-only` and stay
that way.

Nothing from `node_modules` is bundled into `main.js`. The build marks
`obsidian`, `electron` and the CodeMirror and Lezer packages as external,
because Obsidian provides them at runtime, so the shipped `main.js` contains
only Handwriting's own code. The build and test dependencies keep their own
licenses and are not redistributed here.
