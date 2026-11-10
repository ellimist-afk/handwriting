/**
 * The link icon: what shows which ink is attached.
 *
 * What it looks like: every attached group that follows its text and is not selected shows a small grey link icon (two
 * rings, the theme's --text-muted) just outside its top-left corner, the same size at every zoom. A selected group shows
 * today's outline and label instead, and a group that needs reattachment its tag, never an icon. Reading view, print,
 * export and Slides draw no icon: their bytes do not change.
 *
 * The icon is chrome on the committed layer, drawn where the held tag is: the cells read a recording committed context
 * on a bare overlay (attachTapRig.test.util.ts), whose view throws on every layout read. In node the theme's colours are
 * the fallbacks themeColours gives, so the muted colour reads #999999.
 */
import { describe, expect, it } from "vitest";
import { inlineInk } from "./InkOverlayRegistry";
import { inkToSvg } from "../ink/SvgExport";
import { codeOnly } from "../CodeOnly";
import { ATTACH_STRINGS } from "./AttachDecoration";
import { tapRig } from "./attachTapRig.test.util";

const G1 = ["c1", "c2"], G2 = ["d1", "d2"];
const MUTED = "#999999";

/** The icons a committed paint drew: each one's translate (the box corner on screen), its colour and its two rings. */
function iconsIn(ops: string[]): { at: string; colour: string; rings: string[] }[] {
	const out: { at: string; colour: string; rings: string[] }[] = [];
	let at = "", colour = "";
	for (const op of ops) {
		if (op.startsWith("translate ")) at = op.slice(10);
		else if (op.startsWith("strokeStyle ")) colour = op.slice(12);
		else if (op.startsWith("arc ") && op.split(",")[2] === "3.25") {
			const last = out[out.length - 1];
			if (last && last.at === at && last.rings.length === 1) last.rings.push(op.slice(4));
			else out.push({ at, colour, rings: [op.slice(4)] });
		}
	}
	return out;
}
const corner = (b: { x: number; y: number }, zoom = 1, cam = { x: 0, y: 0 }) => `${Math.round((b.x - cam.x) * zoom * 100) / 100},${Math.round((b.y - cam.y) * zoom * 100) / 100}`;

describe("an icon on every following group that is not selected", () => {
	it("nothing selected: g1 and g2 each show the icon at their box's top-left, in the muted colour", () => {
		const r = tapRig("icon-both.md");
		r.redraw();
		const icons = iconsIn(r.paint("all"));
		expect(icons.map((i) => [i.at, i.colour, i.rings.length]), "one icon per group, two rings each, muted").toEqual([
			[corner(r.shownBox(G1)), MUTED, 2],
			[corner(r.shownBox(G2)), MUTED, 2],
		]);
	});

	it("g1 selected: no icon on g1 (its outline instead), the icon on g2", () => {
		const r = tapRig("icon-selected.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const icons = iconsIn(r.paint("all"));
		expect(icons.map((i) => i.at), "the icon on the unselected group only").toEqual([corner(r.shownBox(G2))]);
	});

	it("g2 needs reattachment: its tag and no icon; g1 its icon", () => {
		const r = tapRig("icon-needs.md", { held: ["g2"] });
		r.redraw();
		const ops = r.paint("all");
		expect(iconsIn(ops).map((i) => i.at), "the icon on the following group only").toEqual([corner(r.shownBox(G1))]);
		expect(ops.filter((op) => op.startsWith(`fillText ${ATTACH_STRINGS.needs},`)), "the held group's tag still drawn").toHaveLength(1);
	});

	it("let go of g1: its icon comes back in the next repaint", () => {
		const r = tapRig("icon-letgo.md");
		r.selection.selectExactly(G1);
		r.redraw();
		r.paint("all");
		r.selection.clear();
		const before = r.repaints();
		r.redraw();
		expect(r.repaints() - before, "the redraw asked a repaint").toBeGreaterThan(0);
		expect(iconsIn(r.paint([])).map((i) => i.at), "the icon back on g1 in that repaint").toContain(corner(r.shownBox(G1)));
	});
});

describe("the icon's look: fixed css size, just outside the top-left corner", () => {
	it("the rings are the same at zoom 1 and zoom 2, and sit up and left of the box's corner", () => {
		const one = tapRig("icon-zoom1.md");
		one.redraw();
		const a = iconsIn(one.paint("all"));
		const two = tapRig("icon-zoom2.md", { zoom: 2 });
		two.redraw();
		const b = iconsIn(two.paint("all"));
		// At zoom 2 the 800 by 600 canvas shows world 400 by 300: g1 is in view, g2 below it.
		expect(b.map((i) => i.rings), "g1's rings drawn the same at zoom 2 (css px after the corner's translate)").toEqual([a[0]!.rings]);
		expect(b.map((i) => i.at), "the corner moves with the zoom").toEqual([corner(two.shownBox(G1), 2)]);
		const ext = a[0]!.rings.map((ring) => ring.split(",").map(Number)).map(([x, y, rad]) => [x! + rad!, y! + rad!]);
		expect(ext.every(([right, bottom]) => right! < 0 && bottom! < 0), `the icon clear of the box, up and left: ${JSON.stringify(a[0]!.rings)}`).toBe(true);
	});

	it("a camera move redraws the icon from the kept boxes, no layout read", () => {
		const r = tapRig("icon-camera.md");
		r.redraw();
		r.paint("all");
		r.camera.snapshot = { x: 5, y: 40, zoom: 1.5 };
		// The rig's view throws on every layout read: a read here fails the cell.
		const icons = iconsIn(r.paint("all"));
		expect(icons.map((i) => i.at), "both icons at the moved camera").toEqual([
			corner(r.shownBox(G1), 1.5, { x: 5, y: 40 }),
			corner(r.shownBox(G2), 1.5, { x: 5, y: 40 }),
		]);
	});

	it("the icon moves with its ink: a store move of g1 lands the icon at the new place and clears the old", () => {
		const r = tapRig("icon-move.md");
		r.redraw();
		r.paint("all");
		const old = r.shownBox(G1);
		const rec = inlineInk.record("icon-move.md");
		rec.strokes = rec.strokes.map((s) => {
			if (!G1.includes(s.id)) return s;
			const points = s.points.map((p) => ({ ...p, y: p.y + 30 }));
			return { ...s, points, bbox: { ...s.bbox, y: s.bbox.y + 30 } };
		});
		r.redraw();
		const ops = r.paint([]);
		expect(iconsIn(ops).map((i) => i.at), "the icon drawn at the moved group").toContain(corner(r.shownBox(G1)));
		const cleared = ops.filter((op) => op.startsWith("clearRect ")).map((op) => op.slice(10).split(",").map(Number));
		// The old icon's place on the canvas: it starts 1 left of the canvas edge, where nothing paints.
		const left = Math.max(0, old.x - 15), oldIcon = { x: left, y: old.y - 15, width: old.x - 3 - left, height: 12 };
		expect(cleared.some(([x, y, w, h]) => x! <= oldIcon.x && y! <= oldIcon.y && x! + w! >= oldIcon.x + oldIcon.width && y! + h! >= oldIcon.y + oldIcon.height),
			`the old icon's place cleared: ${JSON.stringify(cleared)}`).toBe(true);
	});
});

/** Reading view, print, export and Slides: no file of theirs reaches the icon, and the export's bytes are the base's. */
describe("reading view, print, export and Slides draw no icon", () => {
	const ALL_TS = import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;
	const OFF_EDITOR = (p: string) => !p.endsWith(".test.ts") && !p.includes(".test.") &&
		(/^\/src\/inline\/EmbedInk[A-Za-z]*\.ts$/.test(p) || /^\/src\/ink\/(SvgExport|InkPdf[A-Za-z]*)\.ts$/.test(p) ||
			p.startsWith("/src/slides/") || p.startsWith("/src/export/") || p === "/src/commands/RegisterExportCommands.ts");

	it("no reading view, print, export or Slides file names the icon or the marks", () => {
		const files = Object.keys(ALL_TS).filter(OFF_EDITOR);
		expect(files.length, "premise: the off-editor files were found").toBeGreaterThan(10);
		const hits = files.filter((p) => /\b(drawLinkIcon|linkIconRect|attachMarks|paintHeldTags|LINK_ICON_PX)\b/.test(codeOnly(ALL_TS[p]!)));
		expect(hits, "files reaching the icon").toEqual([]);
	});

	it("a note with two groups exports the same SVG bytes as at the base", () => {
		const r = tapRig("icon-export.md");
		r.redraw();
		r.paint("all");
		const svg = inkToSvg(inlineInk.strokes("icon-export.md"));
		expect(`${svg.length} ${fnv1a(svg)}`, "the export's length and FNV-1a hash, as at the base").toBe(BASE_SVG);
	});
});

/** The 32-bit FNV-1a hash of a string's UTF-16 code units, as hex. */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h.toString(16).padStart(8, "0");
}

/** inkToSvg of the rig's note at the base commit (its length and fnv1a), read with this file there. */
const BASE_SVG = "5506 ec5f48d4";
