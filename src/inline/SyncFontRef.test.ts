/**
 * A note's ink file taken from another device keeps the overlay's font
 * reference in step with the file's.
 *
 * A phone (20px editor font) opens a note whose ink file has no stored font
 * reference yet and latches 20. The desktop (16px) saves first and stamps 16
 * into the ink file. The phone takes that file through the sync poll. The
 * file's strokes are drawn in the 16px frame, so the phone has to paint them
 * at 20/16 and label what it draws next as 16-frame ink too. If the overlay
 * keeps its old 20, the other device's ink shows at 80% size, pulled toward
 * the top left, and what the phone draws next is saved under the 16px label
 * while drawn in the 20px frame: it grows by a quarter, in place, when the
 * note is opened anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { fontZoomFactor } from "./ZoomScale";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string, x = 0): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y: 0, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 0, width: 10, height: 10 },
	};
}

function inlinePage(id: string, strokes: InkStroke[], fontRefPx?: number): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokes;
	if (fontRefPx !== undefined) p.fontRefPx = fontRefPx;
	return p;
}

/** A phone-sized editor (20px font) over a note whose stored page has no font reference. */
async function phoneOpens() {
	const path = `sync-font-ref-${++serial}.md`;
	paths.add(path);
	const pageId = `sync-font-ref-id-${serial}`;
	let incoming: PageData | null = null;
	let reread: (() => Promise<PageData>) | null = null;
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = reread ? await reread() : inlinePage(pageId, [stroke("old", 0)]);
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		prepareExternalAdoption: async () => ({
			kind: "prepared",
			prepared: { pageId, data: incoming!, reused: false, mtime: 1, stamp: "s" } as never,
		}),
		acceptExternalAdoption() {},
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		filePath: () => path,
		selection: new SelectionModel(),
		scheduleRepaint() {},
		redrawSelectionUI() {},
		refFontPx: 20,
		frame: { locked: false },
		container: null,
	});
	inlineInk.setFontRefPx(path, 20);
	return {
		path,
		pageId,
		overlay,
		/** From here the host's next read of the ink file answers when `answer` is called. */
		holdNextRead() {
			let answer!: (page: PageData) => void;
			const pending = new Promise<PageData>((resolve) => (answer = resolve));
			reread = () => {
				reread = null;
				return pending;
			};
			return answer;
		},
		async otherDeviceWrote(page: PageData) {
			incoming = page;
			expect((await inlineInk.adoptExternal(path, () => true)).outcome).toBe("adopted");
			overlay.noteExternallyReloaded(path);
		},
	};
}

describe("a note's ink file taken from another device (font reference)", () => {
	it("the overlay paints the file's ink at the scale its font reference names", async () => {
		const r = await phoneOpens();
		await r.otherDeviceWrote(inlinePage(r.pageId, [stroke("old", 0), stroke("theirs", 50)], 16));
		expect(inlineInk.fontRefPx(r.path), "premise: the note's reference is now the file's 16").toBe(16);
		expect(
			fontZoomFactor(20, r.overlay.refFontPx),
			"scale the overlay paints the 16px-frame ink at"
		).toBe(fontZoomFactor(20, inlineInk.fontRefPx(r.path)!));
	});

	it("control: a file that names the same reference leaves the scale at one", async () => {
		const r = await phoneOpens();
		await r.otherDeviceWrote(inlinePage(r.pageId, [stroke("old", 0), stroke("theirs", 50)], 20));
		expect(inlineInk.fontRefPx(r.path)).toBe(20);
		expect(fontZoomFactor(20, r.overlay.refFontPx)).toBe(1);
	});

	it("control: a file with no reference at all leaves the phone's own reference", async () => {
		const r = await phoneOpens();
		await r.otherDeviceWrote(inlinePage(r.pageId, [stroke("old", 0), stroke("theirs", 50)]));
		expect(inlineInk.fontRefPx(r.path)).toBe(20);
		expect(fontZoomFactor(20, r.overlay.refFontPx)).toBe(1);
	});

	it("a stroke drawn after the adoption keeps its points when the record is read again", async () => {
		const r = await phoneOpens();
		await r.otherDeviceWrote(inlinePage(r.pageId, [stroke("old", 0), stroke("theirs", 50)], 16));
		// The sync poll reads the file again; a stroke is drawn while the read is out.
		const answer = r.holdNextRead();
		const reading = inlineInk.reloadExternal(r.path);
		inlineInk.commit(r.path, stroke("mine", 100));
		answer(inlinePage(r.pageId, [stroke("old", 0), stroke("theirs", 50)], 16));
		await reading;
		const mine = inlineInk.strokes(r.path).find((x) => x.id === "mine");
		expect(mine, "premise: the stroke is still on the note").toBeDefined();
		expect(mine!.points.map((pt) => pt.x)).toEqual([100, 110]);
	});
});
