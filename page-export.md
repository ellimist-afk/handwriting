# Page export: text and ink in one file

**Status:** scoped, not started. 2026-08-28.

## What it is

One command that writes an `.svg` containing the note's **text and its ink
together**, positioned as they appear on screen.

Two exports exist today and neither is this:

- `Export ink as SVG` writes the strokes alone, cropped to themselves, on a
  transparent background. Good as an asset. Not a page.
- Obsidian's own **Export to PDF** renders the reading view and now carries
  ink. It is the right answer for annotation that lives with the text, and it
  is genuinely good at that.

## Why PDF does not close this

A PDF is paginated and letterboxed, and both properties are structural:

- **Fixed page width.** The note's text column is mapped onto the page. Ink to
  the right of that column has nowhere to go and is clipped. Confirmed on
  hardware, 2026-08-28.
- **Pages.** The surface this plugin gives people is continuous in both axes;
  ink is stored in note coordinates on an unbounded plane. Cutting that into
  letter-sized pieces is a lossy operation no matter how it is done.

So PDF serves the common case and cannot serve the wide one. A single SVG has
neither constraint: one surface, any size.

## Approach

SVG has native `<text>`. Not `foreignObject` - that carries HTML and renders
only in browsers, breaking in Inkscape, Illustrator and every converter.
`<text>` is portable everywhere and keeps the words real: selectable,
searchable, copyable.

`<text>` does not wrap, so every line must be positioned individually. We do
not compute that layout - the browser already did. The pipeline:

1. **Render the whole note.** `MarkdownRenderer.render(app, md, el, path, cmp)`
   into a container attached off-screen at the note's content width. This step
   is not optional: CodeMirror **virtualizes**, so the live editor's DOM holds
   only the visible lines and cannot be measured for a long note.
2. **Measure.** Walk the rendered text nodes; for each, use `Range` client
   rects to get one box per visual line, and binary-search character offsets to
   recover the substring belonging to each box.
3. **Convert.** Screen rects into note coordinates - the same arithmetic
   `syncCamera` already does, divided by scale against the content origin.
4. **Emit.** One `<text>` per line at its measured position, carrying the
   computed font family, size, weight, style and colour of its parent element.
5. **Overlay the ink.** `inkSvgBody` already produces exactly this geometry and
   is already shared with the file export. Ink goes above the text, matching
   the on-screen rule.
6. **Frame.** viewBox = the union of the text bounds and the ink bounds.

## The risk worth naming first

**Registration.** The ink's coordinates were captured against the EDITOR's
layout. This export measures a freshly rendered copy. If that copy wraps or
spaces its lines differently, ink and text disagree - the annotation drifts off
the word it annotates, which is the one failure that makes the file worthless.

The gap already exists in the product: `EmbedInk` states plainly that a
rendered page wraps differently than the editor did and that ink does not chase
text. Reading view has always carried it. This export would inherit it, and
unlike reading view it produces an artifact people keep.

Mitigation is to render into a container matched to the editor - same content
width, same computed font settings - rather than to reading view's defaults.
**M0 exists to measure the residual disagreement before anything else is
built.** If it is large, the feature needs a different anchor and the rest of
this plan is wrong.

## Out of scope for a first version

Text and ink only, on a transparent background. Specifically NOT captured:

- Backgrounds and borders: code block shading, table rules, callout boxes
- Images and embeds
- Fonts are referenced by name, not embedded, so a viewer without them
  substitutes

For prose with annotation this is a faithful page. For a note that is mostly
tables and code it would look bare, and that is the honest description to give
anyone who asks.

## Milestones

- **M0 - registration probe.** Render a note off-screen, measure a handful of
  known lines, compare against the same lines' positions in the editor. Output
  is a number: how far do they disagree? Everything after this depends on that
  number being small. No feature work until it is known.
- **M1 - pure assembly.** `TextRun[] + strokes -> svg string`, DOM-free and
  unit-tested, the way `SvgExport` and `ScrollBand` are. This is where the
  viewBox arithmetic and escaping live.
- **M2 - measurement.** The DOM half: render, walk, split lines, convert
  coordinates. Returns `TextRun[]`. Not pure, kept thin, all judgement pushed
  into M1.
- **M3 - command.** Write `<note>.page.svg` beside the note, alongside the
  existing ink-only export. Both commands named for what they produce.
- **M4 - fidelity.** Bold, italic, colour, links, headings. Whatever M0 says
  about alignment.
- **M5 - optional.** Block backgrounds and borders, if anyone asks.

## Open questions

- Does the off-screen render need the note's frontmatter suppressed, or is the
  properties block wanted in the picture?
- One file per note, or a selection export (the lasso already knows a subset)?
- Long notes: how expensive is per-line measurement, and does it need
  chunking to avoid blocking the UI?
