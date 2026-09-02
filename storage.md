# How Handwriting stores ink

Written against the code in `src/persistence/PageStore.ts`,
`src/inline/InlineInkStore.ts`, `src/model/PageData.ts`,
`src/model/MarkdownPage.ts`, `src/pdf/PdfIdentity.ts` and
`src/pdf/PdfInkStore.ts`. Where this document and the code disagree, the code
is right.

## the split

Your words stay in the Markdown file. Handwriting never puts ink in it.

Ink and layout live in a sidecar: one JSON file per note, under
`.handwriting/` at the vault root, named by the note's page id.

```
<vault>/
  Some note.md                     your text, plus one frontmatter property
  .handwriting/
    3f2a....json                   the ink for that note
    3f2a....json.tmp               only while a save is in flight
    trash/
      3f2a...-1755881041234.json   a copy kept from a delete
```

## identity

The link between a note and its sidecar is one frontmatter property:

```yaml
---
handwriting-page-id: 3f2a91c8-....
---
```

Handwriting writes it on the first stroke and never again. A note you never
ink on is never modified. The property is hidden from the Properties panel,
which is also what keeps the first stroke from making the note jump.

The sidecar is keyed by that id rather than the filename, so renaming or
moving a note keeps its ink. Move the note to another vault without `.handwriting/`
and the ink does not follow; the id stays in the frontmatter, so putting the
sidecar back later reconnects it.

Two other frontmatter keys exist and Handwriting does not add either on its
own. `handwriting: page` means "open this note on the canvas view", and is
written only by `New canvas page`. `handwriting-version` appears only on
notes that carry canvas block markers.

## pdfs

PDF ink is stored exactly like note ink: one JSON file per PDF, under
`.handwriting/`, through the same writes, the same conflict checks and the
same trash.

What differs is identity. A note carries its page id in its frontmatter. A
PDF cannot: there is nowhere to put one, and writing into the PDF is the one
thing this feature promises never to do. So the id comes from the file's
content instead, and looks like this:

```
pdf-4c1f9a2b7e0d5836a1c4e9f20b7d8a63
```

That is a SHA-256 over the first 64 KiB of the file plus its exact byte
length, kept to 32 hex characters. The head rather than the whole file
because a hundred-megabyte scan should not be read end to end every time it
opens. The length is in there so truncation cannot forge an identity: two
documents sharing a 64 KiB prefix, like a template and a filled-in copy of
it, differ in length, and that difference reaches the hash.

Three things follow from keying on content:

- Renaming or moving a PDF costs nothing. The ink follows the bytes.
- Two machines syncing the same file agree on the id by construction, with no
  coordination. This is the only reason ink drawn on a tablet appears on a
  desktop.
- Two copies of the same PDF in one vault are separate INSTANCES: each vault
  file gets its own sidecar, so a fresh copy of a document you already
  annotated starts blank. Export the same source twice and the second file
  is its own clean page, whatever its bytes.

Instances work by path claims. The content hash names a FAMILY; the first
file opened in a family keeps the bare `pdf-<hash>` id (which is exactly the
pre-instance id, so existing sidecars carry straight over), and each further
copy gets `pdf-<hash>-2` and up. Every sidecar records the vault paths it
belongs to, in the sidecar itself - so synced devices agree by reading the
same files, with no coordination.

That is also what keeps renames working: a renamed or moved PDF turns up
with no sidecar claiming its path, but one sidecar's claimed path has just
vanished from the vault - the ink follows. A sidecar with no recorded paths
is older data; the first file to open it adopts it.

The ink is never inside the PDF. It is an overlay from the sidecar, exactly
as on notes. Open the file in any other reader and it is clean; disable the
plugin and it is clean. The file itself is never touched.

**Re-exporting a PDF deliberately does not carry the ink over.** A file that
has been through another editor is a different document, its pages may have
reflowed, and old ink positions would be lies. The sidecar is orphaned rather
than misapplied. The file is kept, nothing is overwritten, and you are told
once.

Stored PDF ink carries `surface: "pdf"`. That marks a separate coordinate
world - page-local CSS pixels at scale 1, measured from the corner of the
page it was drawn on - which must never be read as note-surface geometry.

## the sidecar format

JSON, one object, with `schemaVersion` first. Version 1 is current.

Stable fields, safe to depend on:

- `schemaVersion` (number)
- `pageId` (string, matches the note's `handwriting-page-id`)
- `surface` (`"inline"` for editor ink, `"pdf"` for ink on a PDF; absent
  means a canvas page)
- `strokes` (array; each has `id`, `tool`, `color`, `width`, `createdAt`, and
  points)
- `textBoxes` and `images` (canvas pages only; `id`, position, size, `z`)

Internal, and subject to change without a schema bump:

- how stroke points are packed inside a stroke
- rounding of stored coordinates
- the exact spelling of tool and color values
- the naming of conflict, damaged and trash files

**Unknown fields survive.** Anything Handwriting does not recognise, at the
top level or on an individual stroke or box, is preserved verbatim through a
load and save. This is deliberate: an older Handwriting must not delete a
newer Handwriting's data, and in a synced vault both versions are live at
once. A sidecar that declares a `schemaVersion` higher than this build
understands is never written to at all; the note opens read-only for ink.

Coordinates are note-space CSS pixels at zoom 1. Zoom is a view transform.
No stroke is ever rewritten or rescaled when you zoom.

## when saves happen

A save runs **700 ms after the most recent change**, so a burst of strokes
becomes one write and each pause of that length commits what came before it.

A run of changes with no pause cannot defer a save forever. The first change
of a batch starts a **five-second** clock that later changes do not reset.
Whichever expires first writes the current state.

Nothing is written on the pen path. The eraser, which fires at input rate,
persists once per gesture at pen-up.

The first stroke on a note that has never been inked is a special case: the
page id must be written into the Markdown before any sidecar keyed to it can
exist, so that write is awaited, and the first sidecar write follows
immediately rather than waiting another 700 ms.

A quit before a pending write lands loses what that write was carrying.
Handwriting flushes on unload, but Obsidian does not wait for the flush, so
treat it as best effort.

## how a write happens

Every save writes to `<id>.json.tmp` and renames it over `<id>.json`. A
rename is atomic on the filesystems Obsidian runs on, so an interrupted save
leaves either the old complete file or the new complete file, never a
half-written one.

Writes for one page are serialized, so two saves cannot interleave their
rename dance. A failed write keeps its state queued and retries up to three
times, 1.5 seconds apart, before telling you once.

## recovery

**Interrupted save.** If `<id>.json` is missing but `<id>.json.tmp` is there,
the temporary file is loaded and you are told it was recovered.

**Corrupt main file with a good temporary file.** If `<id>.json` cannot be
parsed and its own `.tmp` is a complete, current-schema page for the same id,
the corrupt bytes are moved to `.handwriting/<id>.damaged-<mtime>.json`, the
temporary file is promoted, and you are told what happened and where the
damaged bytes went. Every condition is re-checked immediately before either
file moves, so a file that changed while the recovery was queued is left
alone. If the temporary file is missing, corrupt, for another page, or a
newer schema, nothing moves and the read-only behaviour below applies.

Handwriting never chooses between two readable files.

**Corrupt sidecar with nothing to recover from.** The note opens read-only
for ink. The file is not overwritten, so a backup or sync copy can still
repair it. Fix the file and reopen the note, and saving resumes.

**Changed by something else.** Before each write Handwriting checks whether
the file on disk is still the one it last read or wrote, by modification time
and then by a content stamp, because sync tools routinely preserve
timestamps. If it changed, the other version is moved to
`.handwriting/<id>.conflict-<mtime>.json`, your session's ink is written, and
you are told, after the write lands rather than before.

## duplicate notes

A page id must belong to exactly one note. Copying a note copies its
frontmatter, so both copies would read and write the same sidecar.

Handwriting checks for that once Obsidian's metadata index is complete after
startup, and again whenever a note's frontmatter changes. The copy gets a
fresh id and its own copy of the ink; the original is never written.

If Handwriting cannot tell which note is the original, it stops saving on
both and tells you how to resolve it: delete the `handwriting-page-id` line
from the copy, and its next stroke mints a new one.

## deletion and trash

When Obsidian reports that a note was deleted while Handwriting is loaded,
its sidecar is **moved** into `.handwriting/trash/` rather than deleted.
That covers deletion inside Obsidian and deletions Obsidian notices on disk
while running. A file removed while Obsidian was closed is never reported, so
nothing moves and the sidecar stays in `.handwriting/`, unreferenced.

`Delete all ink on this note` copies the ink into the trash first, and
refuses to wipe if that copy cannot be written.

Trash files are named `<id>-<timestamp>.json`, with a counter appended if two
land in the same millisecond. Nothing in `.handwriting/trash/` is ever
overwritten, so repeated deletions keep every generation. A sidecar that is
provably empty is deleted rather than adding a useless generation.

**Handwriting never empties that folder.** It only grows. You can clear out
that folder to get the space back. However, delete those files and your ink
will be gone. So don't do it unless you know what you're doing.

## what to back up

`.handwriting/` and your Markdown files. Both.

`.handwriting/` is hidden, and not every sync or backup tool includes hidden
folders by default. Check yours. If it skips them, the backup is missing
every sidecar.

Plugin settings live in `.obsidian/plugins/handwriting/data.json`: per-note
camera positions, the selected nib size and color, and the page-id ownership
map used for duplicate detection. Losing it does not touch any ink.

The atomic-write scheme covers an interrupted save. A failing disk still
needs an ordinary backup.
