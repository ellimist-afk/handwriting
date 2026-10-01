/**
 * Audit probe InkOverlay-6-1 (1.4.21, tag 1a05f62c).
 *
 * Claim: an insert-space drag whose release snaps to zero lines puts the ink
 * back in memory (InkOverlay.ts:10124) and returns (:10125-10131) without a
 * save, so a debounced sidecar write that fired MID-drag leaves the displaced
 * coordinates on disk.
 *
 * Rig: the REAL inlineInk singleton wired to a REAL PageStore over the fake
 * adapter with fake timers (the InlinePersistence.test.ts shape), and the REAL
 * InkOverlayPlugin.prototype.spaceMove / spaceUp on an Object.create overlay
 * (the InkHistoryIdentity.test.ts shape). Only paint, camera and the seam
 * plan (which needs real layout; spaceDown's field writes are reproduced) are
 * stubbed.
 *
 * Asserts the CORRECT behaviour: after every timer, disk == memory. Red only
 * if the zero-snap release leaves displaced ink on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const NOTE = "audit-6-1.md";
const PID = "audit-6-1-pid";
const FINAL = `.handwriting/${PID}.json`;
const LINE = 24; // note-unit line height carried by the frozen plan

function stroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 10, y, pressure: 0.5, t: 0 }, { x: 20, y: y + 10, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y, width: 10, height: 10 }, createdAt: 1,
	} as InkStroke;
}

function diskYs(fake: FakeAdapter): Record<string, number> | null {
	const text = fake.files.get(FINAL);
	if (text === undefined) return null;
	const out: Record<string, number> = {};
	for (const s of parsePage(text, PID).data.strokes) out[s.id] = s.points[0]!.y;
	return out;
}
function memYs(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of inlineInk.strokes(NOTE)) out[s.id] = s.points[0]!.y;
	return out;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function scenario(afterRelease: () => void): Promise<FakeAdapter> {
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never);
		const host: InlineInkHost = {
			readPageId: (p) => (p === NOTE ? PID : null),
			claimId: async () => ({ pageId: PID }),
			loadSidecar: (id) => store.load(id),
			scheduleSidecar: (id, page) => store.schedule(id, page),
			scheduleSidecarNow: (id, page) => store.saveNow(id, page),
			notify() {},
		};
		// Disk: "above" sits over the seam at y=100, "below" under it.
		const page = emptyPage(PID);
		page.surface = "inline";
		page.strokes = [stroke("above", 40), stroke("below", 200)];
		fake.externalWrite(FINAL, serializePage(page));
		inlineInk.attachHost(host);
		await inlineInk.ensureLoaded(NOTE);
		expect(memYs()).toEqual({ above: 40, below: 200 });

		// Overlay: real prototype methods, stubbed paint/camera.
		const state = EditorState.create({ doc: "line one\nline two\nline three\nline four\n" });
		const overlay = Object.create(InkOverlayPlugin.prototype) as any;
		Object.assign(overlay, {
			filePath: () => NOTE,
			camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
			damage: { addRect() {}, addAll() {} },
			scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
			spaceFeedbackRaf: null, spacePreview: null, spaceHoverY: null,
			view: { get state() { return state; }, dispatch: () => { throw new Error("no dispatch expected on a zero snap"); } },
		});

		// 1. An ink edit (e.g. a landed drag's save at :10133) arms the 700 ms debounce.
		inlineInk.save(NOTE);
		await vi.advanceTimersByTimeAsync(100);

		// 2. Space pen-down, reproducing spaceDown's field writes (:10039-10055)
		//    for a seam at y=100 on line 3 with a frozen plan against this doc.
		const plan = { y: 100, from: state.doc.line(3).from, lineHeight: LINE, text: true };
		overlay.spacePlan = { ...plan, doc: state.doc };
		overlay.spaceHistoryIdentity = inlineInk.captureHistoryIdentity(NOTE);
		overlay.spaceLineY = plan.y;
		overlay.spaceFromY = 100;
		overlay.spaceTotalDy = 0;
		overlay.spaceIds = ["below"];
		overlay.spaceBounds = { x: 10, y: 200, width: 10, height: 10 };

		// 3. Drag down 10 note units (under half a 24-unit line) with the REAL spaceMove.
		overlay.spaceMove([{ x: 50, y: 110, pressure: 0.5, t: 0 }]);
		expect(memYs()).toEqual({ above: 40, below: 210 });

		// 4. The pen is held; the debounce fires mid-drag and writes.
		await vi.advanceTimersByTimeAsync(700);
		// Precondition: the queued write DID land mid-drag with the provisional
		// coordinate (the snapshot held the live stroke array).
		expect(diskYs(fake)).toEqual({ above: 40, below: 210 });

		// 5. Release with the REAL spaceUp: lineSteps(10, 24) === 0, zero snap.
		overlay.spaceUp();
		// Precondition: memory is back where it was (the :10124 correction ran).
		expect(memYs()).toEqual({ above: 40, below: 200 });

		afterRelease();
		// 6. Past every save timer (700 ms quiet, 5 s max, retries).
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
		return fake;
}

describe("InkOverlay-6-1: zero-snap insert-space release vs a mid-drag debounced write", () => {
	it("disk matches memory after a zero-snap release whose drag overlapped a queued write", async () => {
		const fake = await scenario(() => {});
		// CORRECT behaviour: what is on disk is what is on screen.
		expect(diskYs(fake), "sidecar on disk after the zero-snap release").toEqual(memYs());
	});
	it("control: the same sequence plus the save rollbackSpaceMove makes (:10430) ends with disk == memory", async () => {
		const fake = await scenario(() => inlineInk.save(NOTE));
		expect(diskYs(fake)).toEqual(memYs());
	});
});
