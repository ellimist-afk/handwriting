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
palette of eight pen inks and five highlighter colors. Size and color apply to
whichever tool is active, and persist across sessions.

Hold the pen still for about a third of a second at the end of a stroke and it
redraws as a line, triangle, rectangle, circle or ellipse. **Shape snap** is a
switch in Settings, on by default. With a mouse, pause at the end of a stroke
and a Snap button appears; click it to snap.

Press harder and the line thickens. **Pressure sensitivity** is a switch in
Settings, on by default, with a **Recalibrate** button beside it: the plugin
learns the hardest press your pen has actually made and scales the width law
to it, so a tablet that reports a narrow pressure range still gets the full
range of widths. Recalibrate forgets what it learned and starts again - worth
doing if you change pens. What it learns is kept per device, not in the
synced settings file, because one pen's range must not silence another's.

## commands

The palette carries the commands the pen toolbar cannot do, and a few it can:
the two nibs and the lasso clipboard commands are always
there, because a hotkey for those is worth more than a shorter list. Most of
the rest of what the toolbar reaches sits behind one switch, **Extra commands
for hotkeys** in Settings, off by default; turn it on and they are in the
palette at once, each ready to take a hotkey. Turn it off and they leave it
again - the toolbar still reaches all of them, and a hotkey you bound is still
bound the next time the switch is on. The left column below is the whole
always list; Settings prints the gated one under the switch either way. On an
Obsidian with no way to un-register a command the row says so, and turning the
switch off waits for a plugin reload.

| always in the palette | with **Extra commands for hotkeys** on |
| --- | --- |
| `Pen on / off` | `Toggle eraser on / off` |
| `Highlighter` | `Toggle lasso on / off` |
| `Mouse on / off` | `Toggle insert space on / off` |
| `Toolbar: auto / show / hide` | `Toggle pan on / off` |
| `Paper: none / lines / grid / dots` | `Ink color: next`, `Pen color: next`, `Highlighter color: next` |
| `Export ink as SVG (drawing only)` | `Ink size: next`, `Eraser size: next` |
| `Export ink as PDF (drawing only)` | `Ink color: <name>`, one per color |
| `Flatten ink into a copy of this PDF` | `Highlighter color: <name>`, one per color |
| `Snip the selection to an image` | `Ink size: fine / medium / bold` |
| `Delete all ink on this note`, `Delete all ink on this PDF` | `Pen preset 1` to `4`, `Highlighter preset 1` to `4` |
| `Lasso: copy / cut / delete selection`, `Lasso: paste` | `Save current pen as preset N`, `Save current highlighter as preset N` |

`Pen on / off` is the one pen command, and it says what it does. Run it and
the pen picks up the nib and inks; run it again and the pen goes back to the
app - taps place the caret, drags select, and on a touch device the on-screen
keyboard comes up. On a machine with no pen at all, where the mouse draws with
whatever tool is lit, the same command is how the mouse picks the nib up and
puts it down; the toolbar stays either way, so the way back is always on
screen.

Coming from 1.4.11, which had two: `Pen` and `Pen: on / off`. This one kept
`Pen`'s id, so a hotkey you bound to `Pen` still works and now runs
`Pen on / off`. But a hotkey bound to the old `Pen: on / off` does nothing,
and the Hotkeys tab has no row left for it either - Obsidian gives a plugin
no way to move a key binding, so bind that key again to `Pen on / off`
yourself. Keyboard mode itself is unchanged: the **Keyboard** button on the
toolbar still turns the pen's ink off and on, and leaves the tool you were
holding in your hand.

`Bug report: record`, `Bug report: send` and `Bug report: show as text` are
always there too - see reporting problems, below. Worth binding:
`Pen on / off`, `Highlighter`, and, with the switch on, `Ink size: next` and
`Ink color: next`.

Quick pens save a colour and a width together. Tap the pen (or highlighter)
button on the strip to open its pop, and press the star: the pair you are
holding becomes a chip in a row of its own, under the size slider and above
the colour swatches - a dot in its own colour, drawn at its
own width. Tap a chip and the nib wears that pen again; the pop closes
and one toast names it. Press and hold a chip for a moment - or right-click
it - to remove it. Four per tool, and a fifth star replaces the last one. The
highlighter keeps its own four. With `Extra commands for hotkeys` on, the
palette also carries `Pen preset 1` to `4`, the same for the highlighter, and
a `Save current pen as preset N` for each slot, so a starred pen can live on
a single key.

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

<!-- IN FLIGHT, two slices land sentences in this paragraph:
     - mouse-toast-ink: turning mouse drawing on now toasts the literal
       "Handwriting: ink" rather than naming the tool the mouse picked up,
       because after the switch whatever touches the glass inks.
     - pen-button-is-the-truth: on a device with no pen the mouse acts as the
       lit tool, and the first real pen contact lights the pen. -->

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

## the pen toolbar

A small floating strip of tools, in the corner of the pane. On mobile it's
the only way to reach most of this - the stylus fix keeps the keyboard down,
and the command palette lives above the keyboard - so it's always there.
On desktop it appears the first time a pen is seen and stays for the session;
**Toolbar placement**
moves it to a 3x3 grid: left, centre or right on the top, middle or bottom row.
The centre-column placements keep the strip centred as buttons fold away, and
only bottom-row pops open upward to stay on the screen.

You can also drag the toolbar by its grip - the six dots at its left-hand end,
or the pill itself when it's collapsed - to any of the nine placements; it
snaps to the nearest one when you let go, and the setting follows.

Left to right: **Pen** and **Highlighter**, then the other things the tip can
be - **Eraser**, **Lasso**, **Insert space** - then **Delete selection**,
**Copy**, **Paste**, and **Undo** and **Redo**.

**Delete selection**, **Copy** and **Paste** go dim rather than disappearing
when there is nothing to delete, copy or paste. The row keeps its shape, so
the button you were reaching for is still where it was a moment ago.

The pen and highlighter icons are drawn in the colour they're currently
writing in, so you can see the ink without opening anything. Tap the tool
you're already holding and its options drop down: a size slider across the
top, your saved pens, and that tool's own palette, each separated by a thin
line. Picking a colour leaves the panel open, so you can set
size and colour in one go. With **Extra commands for hotkeys** on,
`Ink color: next` still cycles the palette from a hotkey.

The **Eraser** has a pop of its own: a size slider, and two chips that choose
what a rub takes. **Stroke**, the default, deletes any line the ring touches,
whole. **Reticle** takes only the part the ring actually covers and leaves
the rest of the line where it was.

Rubbing at a page that has no ink on it says **Handwriting: no ink on the
page to erase** rather than doing nothing quietly, and a lasso on the same
page says the same about selecting. It waits until it is certain: if the
page's ink has not been read from disk yet it stays silent rather than
telling you the page is empty when it is not.

**Pan** - drag the page with the tip - is on the strip everywhere, phones
included; on a small screen it moves behind the **More** button with the
rest, and that order is yours to set. While a pan drag is running the pen
reticle comes off and the cursor becomes a grabbing hand, so nothing is
drawn on the page you are moving.

One button still appears only where it's any use. **Keyboard**, which hands
the page back to the keyboard so taps place a caret instead of ink, appears
once a pen has actually touched this device and stays from then on, restarts
included; a mouse-only machine never shows it. That memory is per vault, per
device: it lives in this machine's own store, keyed to the vault as well as
the machine, not in the vault itself, so a synced vault does not carry it
from a pen tablet to a desktop.

Turning the pen off says **Handwriting: keyboard mode - pen ink paused, tap
to type**; turning it back on says **Handwriting: pen ink active**. Each
toggle owns one message and rewrites it in place rather than stacking a new
one per press, so holding a hotkey down leaves you looking at the state you
are actually in instead of the oldest one still on screen.

On a small screen the row won't fit. Rather than wrapping into a ragged
second line, a **More** button appears at the end: tap it and the buttons
that didn't fit drop down underneath, centred under the row above. Tapping
outside, or picking any tool, puts them away again. On a desktop or a tablet
the row fits and there is no More button.

Buttons leave the first row in a set order: **Redo** first, then **Pan**,
then **Keyboard**, **Paste**, **Copy**, and **Insert space** last. Only as
many go as the width needs, so a row one button too wide loses two - the
More button takes a button's width itself - and a small phone loses five.
The second row reads the other way round, from the button that nearly stayed
to the one that left first, so five moved buttons read Copy, Paste, Keyboard,
Pan, Redo. Pen, Highlighter, Eraser, Lasso, Delete and Undo never leave the
first row at all.

That order is yours to set, in Settings, Handwriting, Toolbar, under **Toolbar
buttons**: drag a handle to set which buttons stay when the toolbar is small.
The bottom of the list disappears first. The six that never leave are shown
above the list, a dashed line marks where the split falls on this screen, and
the preview underneath shows the toolbar at the width this device actually
gives it. Changing the order re-arranges every open toolbar straight away.

The small chevron at the other end collapses the whole strip to a single
pen-shaped button, which is what most people leave it as while writing; it
wears whichever tool is in hand. Tap it to bring the strip back. That choice
follows you between notes for the rest of the session.

The strip keeps clear of the pane's own three-dots menu, sliding beside it or
dropping below it depending on how much room there is.

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

A page keeps living in the folder its ink was found in, so a device that reads
a page out of one folder saves it back to that same file rather than starting
a second copy of it next door.

Earlier versions could start that second copy, on a device whose folder
setting named one folder while the ink sat in the other. The command
`Check for ink split across folders` looks for notes that ended up that way.
It only looks: it changes nothing, moves nothing and deletes nothing, and
both copies are kept exactly where they are. It reports which copy the app is
showing you and which one it isn't, so you can open the folders and compare
them yourself. If it can't list the folders it says so, rather than reporting
that nothing was found.

## writing on PDFs

Open a PDF in the vault and write on it. The tip inks, the eraser end
erases, the side button lassos - the same pen, the same tools, the same
palettes. Ink sticks to the page it was drawn on, scales with the viewer's
zoom, and follows the document across devices.

Keyboard mode works here too. The **Keyboard** button, and `Pen on / off`
with it, stops the pen
inking on a PDF exactly as it does in a note: taps go straight through to the
viewer, so you can select text and use its own controls without putting the
pen down.

Ink on a page is stored in that page's own points, measured from its
top-left corner - not screen pixels, not scroll position. The nib's width
lives in page points too, so a line drawn at any zoom weighs the same on the
page, and thickens along with the text when you zoom in. Zoom, scroll,
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
boxes, images as vault attachments and a pannable camera. Adding that line to
a note's frontmatter is how you make one, and removing it puts the note back
in the editor. The canvas has no palette commands of its own for now - they
were taking up room in a list people were searching for the export and flatten
commands in, and they come back when the canvas is past experimental.

The canvas shares the ink engine and the sidecar format with the inline
surface, but a note's ink belongs to one surface or the other. Ink drawn on
the canvas doesn't show up in the editor, and the editor won't write over a
canvas page's file.

It predates inline ink and is still supported, though the inline surface is
where the work goes now.

## slides

Start Obsidian's own Slides plugin on a note and the pen writes on the
presentation. Every slide keeps its own ink, there the next time you present
that note. A slide boundary is a horizontal rule on its own line with a blank
line above it, exactly as Obsidian's presenter counts slides; a `---` directly
under a single line of text is that line's heading underline, not a boundary.

The tip inks and the eraser end erases, same as everywhere else. `Eraser`
also puts the tip to work erasing on a slide, for pens without a tail end,
and a partial erase there follows the same `Stroke` / `Reticle` choice on the
eraser's own strip button that your notes already use. A pen TAP
on the arrows, or on the close button, still turns the page or closes the
presentation - only a real stroke, one that moves or that you hold down for
a moment, draws instead. Touch and mouse click and swipe the deck exactly as
they always have; only the pen inks or erases.

Ink for the presentation lives in its own file, `<page id>.slides`, beside
the note's own ink file in `.handwriting/`. Add a slide above ones you've
already drawn on, and the ink stays with its own slide instead of sliding
down to the next number. A slide it can't place - one you rewrote, or one
whose text now appears twice in the deck - keeps the slide number it was
drawn on rather than being deleted or guessed at, so after a big edit that
ink can turn up on a different slide; the console line at load says how many
slides that happened to.

Slides ink is on by default and has no settings-tab row of its own yet;
`Toggle slides ink` in the command palette is the way to turn it off, or
back on.

## limitations

<!-- IN FLIGHT, slice ipad-ink-purge-repaint: a line about ink that vanishes
     on iPad after switching apps or under memory pressure, and repaints when
     the app comes back, goes here when that slice merges. -->

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

On iOS and iPadOS the system can reclaim a canvas's pixels under memory
pressure without telling the page, which shows up as ink that vanishes on a
long note beside photos or a PDF. Ink repaints when the app comes back to the
foreground, so switching away and back restores it; the older workaround of
opening another note and returning still works too.

Tested on a Microsoft Surface with a Surface Slim Pen 2. Reports from other
devices are welcome.

## reporting problems

Run `Bug report: record` from the command palette - a dot lights up on the
pen toolbar while it's on, in the theme's accent colour - then reproduce the
problem and run `Bug report: send`. That opens a window with Upload to developer, Copy and
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

Off by default. Turn it on in Settings and reload the plugin to add fifteen
more commands to the palette - scroll trace, ink metrics, pointer hit
probe, region census, and the rest of the instruments this plugin is built
and tested with. `Bug report: record` covers ordinary reporting on its
own; this is for chasing something specific.

`Diagnostics: show PDF pan trace` measures what this plugin costs on a
moving PDF, in two kinds of row. A `pan` row is one move of the Pan tool:
the pointerType holding the page, whether the browser delivered the batch
coalesced, how long the handler took, the scroll it applied and how long the
move waited for the next frame. A `scroll` row is one native scroll of the
viewer - a finger, a wheel, a scrollbar, or the pan's own scrolling coming
back round - with how long our scroll handler took and whether it scheduled
a repaint, which is what separates an expensive scroll event from a cheap
one. Each kind gets its own summary line to paste. Turn on `Bug report:
record`, pan or scroll the page that feels slow, then show it.

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
