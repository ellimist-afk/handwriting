# how Handwriting stores ink

### where ink is stored

your ink is one json file per note in /.handwriting/

(your vault)/.handwriting/

sidecar is a digital photography term that refers to a small file besides a main file that holds information about the main file. this is a useful analogy

in this case, the sidecar stores your ink as coordinates - your note is linked to your ink by a single properties line in the properties field of your note (`handwriting-page-id`). this link + the json coordinates tells Obsidian where all the ink is

what this means practically is that no matter what happens to the ink, the text in your note will be safe, as the note itself is not modified (besides its frontmatter).

disable the plugin and notes stay perfectly readable `.md`; the ink is in the sidecar and won't render.

renaming or moving a note is fine because the id is tied to the sidecar, not the file name of the note. however if you move that note to a different vault you have to bring its json with it, otherwise its ink won't appear. 

if you duplicate a note, the copy gets its own id and its own copy of the ink

currently reviewing a solution + feature that will include the ability to export or "pack" ink into shareable notes/PDFs so others with the plugin can edit the ink on their own devices.

### syncing

the ink is literally json, it will sync between devices just like any other file. however on default settings Obsidian Sync, iCloud and Dropbox won't sync the .handwriting/ folder because it is hidden, and as these services don't sync hidden folders by default, your ink may not appear on your other device

try using Compatibility with Obsidian Sync, iCloud and Dropbox in the settings and hit Turn on. this will move ink into a visible handwriting/ folder so sync services will pick it up. you can Turn off to move it back to being hidden.

recommend starting first with the device with ink already on it. and do this on both devices.

Obsidian Sync also needs **Sync all other types** turned on (Settings > Sync > selective sync). as we covered earlier, your ink is saved as json files and Obsidian Sync skips those by default.

if you quickly write on the same note on two separate, synced devices before they finish syncing (why are you doing this lol) you will end up with a sync conflict with two different versions of your ink. To resolve the sync conflict, open the command palette and run:

Handwriting: fix ink de-sync

in that dialog box, choose either: Keep this device's ink, Take the other, or Keep both. no matter what you choose, nothing gets deleted; both ink files will be saved safely. i am always trying my best to make sure you cannot accidentally get rid of your ink permanently- i think i am always trying to leave at least an option to recover your ink

### pdfs

a pdf doesn't have a properties field so theres not an obvious place to put an id. instead i combined the id from the file's contents with its size to create a unique signature. this serves as the "key" for the json coordinates.

this abstraction enables you to rename or move a pdf around and ink won't break. another bonus is that using a hash is more conducive to the problem of sync; without almost any extra work, opening and viewing the same pdf on two separate devices will get you the same id and thus ink

one json per pdf. the ink is never written into the pdf file itself. you know the drill.

if you want a pdf with annotations saved, you have to "Flatten" the ink onto the page - this will make a pdf copy. the command is called: Flatten ink into a copy of this PDF

finally: a duplicate of a pdf in the same vault starts with no ink

### saving and recovery

I worked hard trying to guarantee that you wouldn't lose your ink no matter how hard you tried. i still didn't make it impossible so be careful. 😭

some things i did included:

before replacing the saved sidecar, Handwriting writes a complete temporary copy. if a save gets corrupted or interrupted, recovery is possible

if an ink file is corrupted, damaged, or can't be read at all, Handwriting will refuse to overwrite it. this will stop you from loading a broken file and accidentally overwriting all the information

in addition, i added `Handwriting: Export ink as SVG (drawing only)` and `Handwriting: Export ink as PDF (drawing only)` commands so you can save your ink to possibly use in other programs. note: those commands only copy your handwriting.

for those who need text and ink export, i did a lot of wet work with Obsidian's native pdf export and viewer in 1.5.1 and beyond to ensure that `Export to PDF` worked like expected.

`Handwriting: Delete all ink on this note` and `Handwriting: Delete all ink on this PDF` always make and save a recovery copy before clearing the page. if that copy can't be saved, the command will refuse to delete ink

deleting a note doesn't delete its ink either. 'orphaned' ink gets moved to .handwriting/trash/ and Handwriting will never empty that folder. you can clear it out yourself if you want the space back. not recommended unless you know what you're doing.

if your ink is still in the hidden .handwriting/ folder, check that your backup tool actually includes hidden folders

finally: deleting the entire handwriting folder will take all its recovery copies with it so be careful with this nuclear option. and back up your vault!!

### the json

the json file formats are laid out like this:

each file has schemaVersion, pageId, surface (inline = notes, pdf = pdfs) and strokes. 

each stroke contains id, tool, color, width, createdAt and its points in this order: x, y, pressure, and time

if you have any questions i will try to answer as best i can
