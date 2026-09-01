/**
 * The M0 verification lens.
 *
 * The design forbids feature code until the live PDF view has been described
 * from the running app rather than from documentation: which element scrolls,
 * what a page div is called, where `--scale-factor` lives, whether the page
 * box divided by that scale is zoom-invariant, and whether the optional
 * internal path exists. This prints all of it.
 *
 * It also exists on day one on purpose. The previous surface shipped before
 * its metrics command did, and every question about it then cost a build; the
 * instrument arriving first is the correction to that.
 *
 * Read-only. Nothing here writes, patches, or attaches anything.
 */

import { App, apiVersion } from "obsidian";
import { findScroller, probeInternalPath, probeViewer } from "./PdfViewerProbe";

/** The line V2 is read from: page box over scale should not move with zoom. */
function invariantLine(widthPx: number, heightPx: number, scale: number | null): string {
	if (scale === null || scale === 0) return "    base: (no scale factor to divide by)";
	const w = widthPx / scale;
	const h = heightPx / scale;
	return `    base: ${w.toFixed(2)} x ${h.toFixed(2)}  (clientWidth/scale, must not move with zoom)`;
}

export function pdfInkReport(app: App): string {
	const lines: string[] = [];
	// The module export, not a global - the first attempt read a global that
	// does not exist and reported "(unknown)", which would have left the
	// findings unattributed to a version.
	lines.push(`obsidian api ${apiVersion || "(unknown)"}`);

	const leaves = app.workspace.getLeavesOfType("pdf");
	lines.push(`pdf leaves open: ${leaves.length}`);
	if (leaves.length === 0) {
		lines.push("");
		lines.push("Open a PDF and run this again. For V2, run it once at the");
		lines.push("current zoom and once after zooming, then compare the base lines.");
		return lines.join("\n");
	}

	leaves.forEach((leaf, i) => {
		const view = leaf.view as unknown as { containerEl?: HTMLElement; getViewType?: () => string };
		const root = view?.containerEl;
		lines.push("");
		lines.push(`--- leaf ${i + 1} ---`);
		lines.push(`view type: ${typeof view?.getViewType === "function" ? view.getViewType() : "?"}`);
		if (!root) {
			lines.push("no containerEl; nothing observable");
			return;
		}
		const win = root.ownerDocument.defaultView ?? window;
		const { matched } = findScroller(root);
		lines.push(`scroller selector matched: ${matched}`);

		const probed = probeViewer(root, win);
		if (!probed) {
			lines.push("probeViewer: null (markup not recognized - this is the disable path)");
			// Still worth dumping what IS there, or a rename is invisible.
			const kids = Array.from(root.children) as HTMLElement[];
			lines.push(`root children: ${kids.map((k) => k.className || k.tagName).join(" | ")}`);
			return;
		}
		lines.push(
			`scroller: ${probed.scroller.className || "(no class)"}` +
				`  client ${probed.scroller.clientWidth}x${probed.scroller.clientHeight}` +
				`  scroll ${probed.scroller.scrollWidth}x${probed.scroller.scrollHeight}`
		);
		lines.push(`--scale-factor: ${probed.scaleFactor ?? "(absent)"}  from ${probed.scaleSource}`);
		// Summarised, not listed. A hundred pages of identical lines buries
		// the two things worth reading: whether the geometry is uniform, and
		// how many pages the viewer considers live.
		const pages = probed.pages;
		const withCanvas = pages.filter((p) => p.hasCanvas);
		lines.push(`page divs: ${pages.length}  with a rendered canvas: ${withCanvas.length}`);
		if (withCanvas.length > 0 && withCanvas.length < pages.length) {
			const nums = withCanvas.map((p) => p.pageNumber);
			lines.push(`  live pages: ${nums.join(", ")}  <- the viewer's own window`);
		}
		const strides = pages.slice(1).map((p, i) => p.topPx - pages[i]!.topPx);
		const uniform = strides.length > 0 && strides.every((s) => s === strides[0]);
		lines.push(
			`stride: ${uniform ? `${strides[0]} px, uniform` : `VARIES (${[...new Set(strides)].join(", ")})`}`
		);
		for (const p of pages.length <= 6 ? pages : [pages[0]!, pages[1]!, pages[pages.length - 1]!]) {
			lines.push(
				`  page ${p.pageNumber}: box ${p.widthPx}x${p.heightPx}` +
					`  at ${p.leftPx},${p.topPx}  canvas ${p.hasCanvas ? "yes" : "no"}`
			);
			lines.push(invariantLine(p.widthPx, p.heightPx, probed.scaleFactor));
			const cb = p.canvasBox;
			// Three cases, and the middle one must not read as the first:
			// `canvasBoxOf` is null both when there is no canvas and when the
			// canvas is positioned against something other than the page div -
			// which is the one shape of offset this report cannot measure, and
			// "(none on this page)" under "canvas yes" would hide exactly that.
			lines.push(
				cb
					? `    viewer canvas: ${cb.widthPx}x${cb.heightPx} at ${cb.leftPx},${cb.topPx}` +
							`  <- our overlay must match THIS, not the div`
					: p.hasCanvas
						? "    viewer canvas: present, but not positioned against the page div -" +
							" its offset cannot be read here; please report this line"
						: "    viewer canvas: (none on this page)"
			);
			// Measured on every platform so far as 0,0 - and NOTHING in the
			// ink path applies it, deliberately (writing overlay geometry was
			// three bugs in one afternoon). If a platform ever offsets the
			// canvas inside its page div, ink there lands wrong by exactly
			// this much, and this line is the one that has to say so.
			if (cb && (cb.leftPx !== 0 || cb.topPx !== 0)) {
				lines.push(
					`    *** CANVAS OFFSET ${cb.leftPx},${cb.topPx}: ink on this platform will ` +
						`miss by this much - please report this line ***`
				);
			}
			if (cb && probed.scaleFactor) {
				lines.push(
					`    canvas base: ${(cb.widthPx / probed.scaleFactor).toFixed(2)} x ` +
						`${(cb.heightPx / probed.scaleFactor).toFixed(2)}`
				);
			}
		}
		lines.push(`internal path: ${probeInternalPath(leaf.view)}`);
	});

	lines.push("");
	lines.push("V2: run again at a different zoom. Every `base` line must be");
	lines.push("unchanged. If it moves, the scale source is wrong and the page");
	lines.push("coordinate base has to come from somewhere else.");
	return lines.join("\n");
}
