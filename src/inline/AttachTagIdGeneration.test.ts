/**
 * An opaque group's tag reads its strokes through an id map kept per stroke list and generation. A list changed in place
 * (a stroke removed, a stroke swapped at the same index) at a new generation reads the live strokes, the held tags
 * re-work when the list changes in place, and an unchanged list at an unchanged generation reuses its map. Bare overlay
 * stand-ins: no DOM, no layout.
 */
import { describe, expect, it, vi } from "vitest";
import { attachChromeOf, heldTagsStale, refreshHeldTags, syncWithoutChrome, type ChromeOverlay } from "./AttachDecoration";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import type { AttachmentData, OpaqueAttachment } from "./InkAttachments";

const PATH = "note.md";
/** One opaque group naming two strokes: its tag is the union of the strokes it finds. */
const OPAQUE: OpaqueAttachment = { opaque: true, id: "op", raw: { strokeIds: ["s1", "s2"] } };
const LIST: AttachmentData[] = [OPAQUE];

function stroke(id: string, x: number, y: number): InkStroke {
	const points = [{ x, y, pressure: 0.5, t: 0 }, { x: x + 20, y: y + 10, pressure: 0.5, t: 1 }];
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 0), createdAt: 1 };
}

function overlay(): ChromeOverlay {
	const follow = { setList: () => {}, followsText: () => false, groupOffset: () => ({ dx: 0, dy: 0 }) };
	return {
		filePath: () => PATH,
		selection: { strokeIds: [], revision: 0, isEmpty: true },
		lineAnchors: { follow, freeFor: () => ({ free: [], members: new Map() }) },
		view: { dom: { isConnected: false }, dispatch: () => {} },
		camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
		cssScale: 1,
		damage: { addRect: () => {} },
		refreshStrip: () => {},
		scheduleRepaint: () => {},
	} as unknown as ChromeOverlay;
}

/** The one tag box the chrome shows. */
function tagBox(chrome: ReturnType<typeof attachChromeOf>): unknown {
	expect(chrome.labels).toHaveLength(1);
	return chrome.labels[0]!.box;
}

describe("the opaque group's id map follows the stroke list's generation", () => {
	it("a stroke removed in place at a new generation drops out of the tag", () => {
		const o = overlay(), s1 = stroke("s1", 10, 10), strokes = [s1, stroke("s2", 300, 300)];
		attachChromeOf(o, LIST, strokes, 0);
		strokes.splice(1, 1);
		expect(tagBox(attachChromeOf(o, LIST, strokes, 1))).toMatchObject(computeBBox(s1.points, 0));
	});

	it("a stroke swapped at the same index at a new generation shows its new geometry", () => {
		const o = overlay(), s1 = stroke("s1", 10, 10), strokes = [s1, stroke("s2", 300, 300)];
		attachChromeOf(o, LIST, strokes, 0);
		const swapped = stroke("s2", 500, 500);
		strokes[1] = swapped;
		expect(tagBox(attachChromeOf(o, LIST, strokes, 1))).toMatchObject(computeBBox([...s1.points, ...swapped.points], 0));
	});

	it("an unchanged list at an unchanged generation reuses its id map", () => {
		const o = overlay(), strokes = [stroke("s1", 10, 10), stroke("s2", 300, 300)];
		const map = vi.spyOn(strokes, "map");
		attachChromeOf(o, LIST, strokes, 0);
		attachChromeOf(o, LIST, strokes, 0);
		expect(map).toHaveBeenCalledTimes(1);
	});

	it("a held group whose stroke list changed in place marks its tags stale", () => {
		const o = overlay(), strokes = [stroke("s1", 10, 10), stroke("s2", 300, 300)];
		syncWithoutChrome(o, LIST, strokes, 0);
		refreshHeldTags(o, LIST, strokes, 0, 1, "all");
		expect(heldTagsStale(o)).toBe(false);
		strokes.splice(1, 1);
		syncWithoutChrome(o, LIST, strokes, 1);
		expect(heldTagsStale(o)).toBe(true);
	});
});
