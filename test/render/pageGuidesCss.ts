/**
 * The page guides' screen rules, copied from styles.css (from `.handwriting-page-guides {` through the off rule).
 *
 * WHY THE RIG NEEDS THEM. Obsidian loads styles.css, and only that file makes the guides' box `position: absolute`.
 * No page of this rig loads it, so without these rules the box is an ordinary child of `.cm-scroller`, which CodeMirror
 * styles `display: flex !important`: the box becomes a flex item ahead of `.cm-sizer` and pushes the text column right,
 * or squeezes it to a few px on a narrow pane. Five render files went red on that and on nothing the product draws.
 *
 * PageGuidesRigCss.test.ts fails when this copy and styles.css differ. To refresh it, copy the same slice again.
 */
export const PAGE_GUIDES_CSS = ".handwriting-page-guides {\n\tposition: absolute;\n\tleft: 0;\n\tz-index: -1;\n\tpointer-events: none;\n\tbackground-image: repeating-linear-gradient(\n\t\tto bottom,\n\t\ttransparent 0px,\n\t\ttransparent calc(var(--handwriting-page-guide-pitch, 979.2px) - var(--handwriting-paper-rule, 1px)),\n\t\tcolor-mix(in srgb, var(--background-modifier-border) 50%, transparent) calc(var(--handwriting-page-guide-pitch, 979.2px) - var(--handwriting-paper-rule, 1px)),\n\t\tcolor-mix(in srgb, var(--background-modifier-border) 50%, transparent) var(--handwriting-page-guide-pitch, 979.2px)\n\t);\n\tbackground-repeat: repeat;\n\tbackground-position: 0 0;\n\tbackground-size: auto;\n}\n/* Not painted while a pinch or ctrl+wheel preview lives (measured: painted, the box more than doubled the preview's\n   raster; blanked, it cost what no box costs). The box's own class, not the scroller's: paper none never sets that one.\n   Back at the settle, when the class comes off. */\n.handwriting-page-guides.handwriting-page-guides-previewing {\n\tbackground-image: none !important;\n}\n/* The Page guides setting, off: applyPaperTo puts this class on every window's body; the box stays in the page and\n   is not drawn. Turned back on, the class comes off and the box shows again, no reopen. */\nbody.handwriting-page-guides-off .handwriting-page-guides {\n\tdisplay: none;\n}";
