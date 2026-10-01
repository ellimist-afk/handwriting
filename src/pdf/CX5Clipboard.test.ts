import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { clearInkClipboard, copyInk, inkClipboardMarker, markerIsCurrent, pasteInk } from "../inline/InkClipboard";

function stroke(id: string, x: number): InkStroke {
	const points = [0, 5, 10].map((v) => ({ x: x + v, y: 30 + v, pressure: 0.5, t: v }));
	return { id, points, bbox: computeBBox(points, 2), tool: "pen", color: "#112233", width: 2, createdAt: 0, page: 1 };
}

function rig(options: { id?: string | null; synthetic?: boolean; denied?: boolean; empty?: boolean } = {}) {
	let ink = options.empty ? [] : [stroke("pdf-ink", 100)];
	let systemText = "old text";
	const writeText = vi.fn(async (text: string) => {
		if (options.denied) throw new Error("clipboard denied");
		systemText = text;
	});
	const win = { navigator: { clipboard: { writeText } } } as unknown as Window;
	const controller = new PdfInkController({ querySelector: () => null } as unknown as HTMLElement, win,
		() => ink, () => options.id === undefined ? "pdf-id" : options.id,
		() => ink, (op) => { ink = applyOp(ink, op); }, () => {}, () => {}, () => {}, () => options.synthetic ?? false);
	const access = controller as unknown as { selected: string[]; selectionPage: number };
	access.selected = ["pdf-ink"];
	access.selectionPage = 1;
	return { controller, writeText, systemText: () => systemText, ink: () => ink };
}

describe("PDF publishes the current session ink marker", () => {
	beforeEach(() => clearInkClipboard());
	for (const previous of [false, true]) {
		it(`publishes PDF copy for note paste, previous note copy=${previous}`, async () => {
			if (previous) copyInk([stroke("note-ink", 10)], "note.md");
			const old = inkClipboardMarker();
			const r = rig();
			r.controller.copySelection();
			await Promise.resolve();
			expect(r.writeText).toHaveBeenCalledOnce();
			expect(r.systemText()).toBe(inkClipboardMarker());
			expect(r.systemText()).not.toBe(old);
			expect(markerIsCurrent(r.systemText())).toBe(true);
			expect(pasteInk("note.md")[0]!.points).toEqual(stroke("pdf-ink", 100).points);
		});
	}
	it("cut publishes before deleting, using the owning window clipboard", async () => {
		const r = rig();
		r.controller.cutSelection();
		await Promise.resolve();
		expect(r.ink()).toEqual([]);
		expect(r.writeText).toHaveBeenCalledOnce();
		expect(markerIsCurrent(r.systemText())).toBe(true);
		expect(pasteInk("note.md")).toHaveLength(1);
	});
	for (const options of [{ empty: true }, { id: null }, { synthetic: true }]) {
		it(`preserves prior clipboard for refused copy ${JSON.stringify(options)}`, () => {
			copyInk([stroke("note-ink", 10)], "note.md");
			const marker = inkClipboardMarker();
			const r = rig(options);
			r.controller.copySelection();
			expect(r.writeText).not.toHaveBeenCalled();
			expect(inkClipboardMarker()).toBe(marker);
		});
	}
	it("denied system clipboard leaves command paste usable", async () => {
		const r = rig({ denied: true });
		r.controller.copySelection();
		await Promise.resolve();
		expect(r.writeText).toHaveBeenCalledOnce();
		expect(pasteInk("note.md")[0]!.points).toEqual(stroke("pdf-ink", 100).points);
	});
});
