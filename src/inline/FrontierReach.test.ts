/**
 * The surface extent's frontier with attached groups: free ink's frontier, cached on the free
 * list, merged with each shown group's box at its correction. A follow walks no stroke list; the frontier keeps its object
 * while its value holds (so the extent's four layout reads are skipped) and is a new object when a group's move changes
 * it, growing and shrinking exactly. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { AttachFollow } from "./AttachFollow";
import { FrontierCache } from "./FrontierCache";
import { InkOverlayPlugin } from "./InkOverlay";
import { LineAnchors } from "./LineAnchor";

const LINES = 40;
const DOC = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`)).toString();
const PATH = "frontier-reach.md";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const word = "line 3 words";
const record = (strokeIds: string[]): AttachmentRecord => {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 89 } };
};
const view = (y: number) => ({ inView: () => true, refAt: () => ({ x: 0, y }), blockTop: () => y - 80 });

/** A group of two members near the top, and free ink whose frontier is `freeBottom` low. */
function setup(freeBottom: number) {
	const f = new AttachFollow();
	const r = record(["s1", "s2"]);
	f.setList([r]);
	f.attached(r, 80);
	const members = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)];
	for (const s of members) f.shown(s);
	const free = [strokeAt("free", 10, freeBottom - 12)];
	const map = new Map([["att-1", members]]);
	const cache = new FrontierCache();
	const move = (y: number) => { f.layoutChanged(); f.measure(view(y)); };
	const reach = () => cache.reach(PATH, free, f.shownBoxes(map));
	return { f, cache, members, free, move, reach };
}

describe("the extent's frontier with attached groups", () => {
	it("the lowest group moving down one line grows the frontier by that line, as a new object", () => {
		// Defect: the merge leaves the groups out, and ink moved down past the free frontier has no scroll room.
		const { cache, members, move, reach } = setup(50);
		const before = reach();
		expect(before.frontier.y).toBeCloseTo(members[1]!.bbox.y + members[1]!.bbox.height, 9);
		move(120);
		const after = reach();
		expect(after.frontier).not.toBe(before.frontier);
		expect(after.frontier.y - before.frontier.y).toBeCloseTo(40, 9);
		expect(cache.passes, "a follow walks the free list once, at the first read").toBe(1);
	});

	it("moving back up shrinks it exactly: no room left below the ink", () => {
		// Defect: the frontier only grows (a stale extent after lines are deleted above), against the world edge at settle.
		const { move, reach } = setup(50);
		const start = reach().frontier.y;
		move(120);
		const down = reach();
		move(80);
		const up = reach();
		expect(up.frontier).not.toBe(down.frontier);
		expect(up.frontier.y).toBeCloseTo(start, 9);
	});

	it("free ink lower than every group: a follow keeps the same frontier object and walks nothing", () => {
		// Defect: each follow hands updateExtent a new frontier object, and the four layout reads run on every keystroke.
		const { cache, move, reach } = setup(5000);
		const first = reach();
		for (const y of [120, 160, 100]) {
			move(y);
			expect(reach().frontier).toBe(first.frontier);
		}
		expect(cache.passes).toBe(1);
	});

	it("a membership change recomputes free ink once; the same value keeps the same object", () => {
		// Defect: a membership change keeps a frontier of the old free list; or every recompute forces layout reads.
		const { cache, move, reach } = setup(5000);
		const first = reach();
		cache.invalidate(PATH);
		move(140);
		const after = reach();
		expect(cache.passes).toBe(2);
		expect(after.frontier).toBe(first.frontier);
	});
});

describe("a follow move leaves the frontier to the merge", () => {
	it("followMoved drops no frontier: the free part stays cached across the move", () => {
		// Defect: followMoved invalidates the frontier cache, and the next extent update walks all 28k strokes (row 1 at 0d59bfd5).
		const anchors = new LineAnchors(() => null);
		const follow = anchors.follow;
		const r = record(["s1", "s2"]);
		follow.setList([r]);
		follow.attached(r, 80);
		for (const s of [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)]) follow.shown(s);
		const dropped: string[] = [];
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty: false,
			attachedLayer: { stillAt: () => true, moved: () => {}, invalidate: () => {} },
			strokeIndex: { remove: () => {}, insertLike: () => {}, replaceMoved: () => {} },
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: (p: string) => dropped.push(p) },
			scheduleRepaint: () => {},
			lineAnchorsMoved: () => dropped.push("membership"),
		});
		const before = follow.snapshot();
		follow.layoutChanged();
		follow.measure(view(120));
		overlay.followMoved(PATH, before);
		expect(dropped).toEqual([]);
	});
});
