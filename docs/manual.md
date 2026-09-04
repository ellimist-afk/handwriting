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

Markdown reflows wherever it wants. Your ink stays where you put it. Only the
insert space tool moves it, by design. Ink scrolls with the note and scales with
Obsidian's zoom (Ctrl +/-, Ctrl-scroll quick font size, pinch). Ctrl+Z undoes
ink and text edits in the order they happened. Draw below the last line or far
off to the right and the note grows scroll room to reach it.

Ink prediction draws a little ahead of the pen to hide display latency. It
is on by default; turn it off in settings if the line runs ahead of the nib
or flicks past sharp corners.

To wipe a note, run `Delete all ink on this note`. It asks first, copies the
ink to the trash described in [storage.md](storage.md), and one undo brings
everything back.

By default, only the pen draws. Touch and mouse keep working the way they do
everywhere else in Obsidian, with a few exceptions that exist to keep the pen
reliable.

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

## e-ink and Boox

E-ink pays for every redraw, and the Android webview on those devices hands
over pen events late: the first NoteAir trace measured a median 58ms between
the pen moving and the plugin hearing about it. Two things follow.

Turn on **Boox mode** in the plugin settings. It sizes ink prediction to that
delay, turns off smoothing and the pen reticle, stops the toolbar animating,
and makes the end of a stroke clear only the ink it drew instead of the whole
screen, which on e-ink was a full refresh per stroke. Your own settings come
back when you switch it off.

Set the device's per-app refresh mode for Obsidian to its fastest option (X
mode or similar) in the Boox system settings. That is the largest lever and
it is outside the plugin.

If it still lags, run the bug report command. It records a short pen trace,
and that trace is how Boox mode got its numbers.

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

`.handwriting/` is hidden, and about half of all sync tools don't carry hidden
folders by default. Obsidian Sync, iCloud and Dropbox don't. If you use one of
these, turn on **Compatibility with Obsidian Sync, iCloud and Dropbox** in the settings panel to get
your ink syncing across devices.

## writing on PDFs

Open a PDF in the vault and write on it. The tip inks, the eraser end
erases, the side button lassos - the same pen, the same tools, the same
palettes. Ink sticks to the page it was drawn on, scales with the viewer's
zoom, and follows the document across devices.

Ink on a page is stored in that page's own points, measured from its
top-left corner - not screen pixels, not scroll position. Zoom, scroll,
resize, none of it moves a stroke once it's down. If the viewer rebuilds
itself mid-stroke - a zoom, most often - the stroke commits what was drawn
instead of vanishing; only the gesture ends. The same holds for a pinch
that lands mid-stroke.

The PDF itself is never modified. Ink lives in a sidecar in `.handwriting/`,
keyed to the file's content rather than its name, so renaming or moving the
PDF costs nothing and two copies of the same document share their ink. A PDF
that has been re-exported through another editor is a different document -
its old ink is set aside rather than guessed onto pages that may have moved.
Backgrounding the app writes whatever's pending immediately, the same as
notes - nothing waits on a timer.

Two commands take the ink out of the vault:

`Flatten ink into a copy of this PDF` writes `name.ink.pdf` beside the
original, with the ink drawn into the pages. Anyone can open it; nothing else
is needed. The original is untouched, and a second flatten gets a numbered
name instead of replacing the first. An encrypted document is refused, with
the reason shown. The ink is drawn with the same outline writer as SVG
export, so the two agree on shape - caps and joints no longer leave a gap
where the outline crosses itself.

`Export ink as PDF (drawing only)` does the same for a note's ink: one page,
sized to the drawing, written beside the note as `name.ink.pdf`. Like the SVG
export it carries the drawing alone, on no background.

`Snip the selection to an image` renders the lassoed region - page and ink
together - to a PNG beside the PDF, and puts embed markdown on the clipboard
with a link back to the page it came from. It only sees the PDF you're
looking at, so a selection in a different pane can't end up in the wrong
file's snip. The same command snips a note's lasso selection too.

Insert space works on the ink: draw the divider and everything in the rows
below it follows the pen down the page. The page itself never grows - it is
the room between your annotations that opens.

To wipe a document, run `Delete all ink on this PDF`. It asks first and
copies the ink to `.handwriting/trash/` before removing anything, the same
bargain the note command makes.

## the canvas

**The canvas is early and rough. Parts of it are broken and I wouldn't
trust important ink to it yet — bug reports are welcome. Your strokes are
stored in the same sidecar as notes and PDFs, so this won't touch your
Markdown, but treat the surface itself as experimental.**

A note with `handwriting: page` in its frontmatter opens in a dedicated
canvas view instead of the editor, with its own toolbar, free-placed text
boxes, images as vault attachments and a pannable camera. The ribbon's **New canvas
page** button creates one, and `Open canvas page as Markdown` opens it in
the editor for the rest of the session; it goes back to the canvas
next time unless you remove the `handwriting: page` line.

The canvas shares the ink engine and the sidecar format with the inline
surface, but a note's ink belongs to one surface or the other. Ink drawn on
the canvas doesn't show up in the editor, and the editor won't write over a
canvas page's file.

It predates inline ink and is still supported, though the inline surface is
where the work goes now.

## limitations

Ink draws in the Markdown editor, in Live Preview and source mode, and shows
in Reading View, embeds, and print.

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

## reporting problems

Run `Bug report: record` from the command palette - a red dot lights up on
the pen toolbar while it's on - then reproduce the problem and run
`Bug report: send`. That opens a window with Upload to developer, Copy and
Save to vault up front, and a Show data button that expands the raw trace
(pointer events, timing, device and window size, the ink settings that
were active) if you want to look at it.

Upload sends the trace to the developer's server; the id it returns appears
in the modal, tap-to-select, so you can put it in your issue instead of the
whole trace. It's the only thing Handwriting sends over the network, and
only on that press - Copy and Save to vault stay offline. The trace is pen
coordinates, timing and device info, never your note's text.

Running `Bug report: send` or `Bug report: show as text` stops the
recording the moment it opens - what you see is what you deliver. Getting
the report out after that - Copy, Save to vault or Upload, whichever
succeeds - clears the buffer too. `Bug report: record`, run again, or a
press-and-hold on the toolbar dot, stops recording without opening
anything, for abandoning one outright.

Send before recording anything and it says so instead of opening an empty
window. Recording on with nothing reproduced yet gets its own message.

## developer diagnostics

Off by default. Turn it on in Settings and reload the plugin to add thirteen
more commands to the palette - scroll trace, ink metrics, pointer hit
probe, region census, and the rest of the instruments this plugin is built
and tested with. `Bug report: record` covers ordinary reporting on its
own; this is for chasing something specific.

## building and testing

Node 20 or newer.

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

Contributions are welcome under `CC-BY-NC-ND-4.0`. [CONTRIBUTING.md](../CONTRIBUTING.md)
lists the checks to run before opening a pull request. For a security
defect, don't open a normal issue; [SECURITY.md](../SECURITY.md) has the
private reporting path.

## license details

Handwriting is free, under CC BY-NC-ND 4.0. Source code is available here:
[github.com/ellimist-afk/handwriting](https://github.com/ellimist-afk/handwriting)

Use it and share it, with attribution, for anything noncommercial, including
your own work you get paid for. You may not sell it, use it commercially, or
distribute a modified version. For any of those, ask. The full text is in
[LICENSE](../LICENSE).

Releases up to and including 1.3.8 went out under `AGPL-3.0-only`, and
1.3.9 under PolyForm Strict 1.0.0; those releases stay that way.

Nothing from `node_modules` is bundled into `main.js`. The build marks
`obsidian`, `electron` and the CodeMirror and Lezer packages as external,
because Obsidian provides them at runtime, so the shipped `main.js` contains
only Handwriting's own code. The build and test dependencies keep their own
licenses and are not redistributed here.
