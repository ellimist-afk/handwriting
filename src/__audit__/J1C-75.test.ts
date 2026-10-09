/**
 * J1C-75: with one PDF open in two panes, a live gesture in pane A must reach
 * pane B when the gesture ends. Real code: HandwritingPlugin.syncPdfControllers
 * (the op sink and persist callback it hands each controller) and a real
 * PdfInkStore. Stubbed: PdfInkController class (records ctor args, idle=true,
 * refresh spy - exactly what main.ts's fan-out uses), workspace, resolvePdfId,
 * store host.
 */
import { describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as Array<{ args: unknown[]; idle: boolean; refresh: ReturnType<typeof vi.fn> }>);

vi.mock("../pdf/PdfInkController", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class RecordingController {
		idle = true;
		refresh = vi.fn();
		args: unknown[];
		constructor(...args: unknown[]) {
			this.args = args;
			made.push(this as never);
		}
		mount(): void {}
		unmount(): void {}
		forgetHistory(): void {}
	}
	return { ...actual, PdfInkController: RecordingController };
});

import HandwritingPlugin from "../main";
import { PdfInkStore } from "../pdf/PdfInkStore";
import type { InkStroke } from "../ink/Stroke";
import { emptyPage } from "../model/PageData";

function stroke(id: string, y: number): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y, pressure: 0.5, t: 0 }, { x: 20, y: y + 10, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y, width: 10, height: 10 },
	} as InkStroke;
}

describe("J1C-75: second pane on the same PDF after a live gesture", () => {
	it("is refreshed when the gesture in the first pane ends", async () => {
		const pdfStore = new PdfInkStore();
		pdfStore.attachHost({
			load: async (id: string) => ({ data: { ...emptyPage(id), surface: "pdf", strokes: [stroke("s1", 10), stroke("s2", 40)] } }),
			schedule: () => {},
			notice: () => {},
		} as never);
		await pdfStore.ensureLoaded("doc");
		expect(pdfStore.strokes("doc").length, "precondition: store loaded").toBe(2);

		const win = { setTimeout, clearTimeout, requestAnimationFrame: () => 0 };
		const rootA = { isConnected: true, ownerDocument: { defaultView: win } } as unknown as HTMLElement;
		const rootB = { isConnected: true, ownerDocument: { defaultView: win } } as unknown as HTMLElement;
		const file = { path: "a.pdf" };
		const leaves = [rootA, rootB].map((containerEl) => ({ view: { containerEl, file } }));

		const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
		plugin.app = { workspace: { getLeavesOfType: (t: string) => (t === "pdf" ? leaves : []) } };
		plugin.pdfInk = new Map();
		plugin.pdfIds = new Map();
		plugin.pdfFiles = new Map();
		plugin.pdfStore = pdfStore;
		plugin.pdfCalibration = false;
		plugin.settings = { inkPdfColorMode: "auto" };
		plugin.resolvePdfId = (): Promise<void> => Promise.resolve();

		(plugin as unknown as { syncPdfControllers(): void }).syncPdfControllers();
		expect(made.length, "precondition: one controller per pane").toBe(2);
		(plugin.pdfIds as Map<HTMLElement, string>).set(rootA, "doc");
		(plugin.pdfIds as Map<HTMLElement, string>).set(rootB, "doc");

		const [a, b] = made;
		const onOp = a!.args[5] as (op: unknown, mode?: string) => void;
		const persist = a!.args[8] as (id: string) => void;

		for (let i = 0; i < 5; i++) onOp({ type: "move", path: "doc", strokeIds: ["s2"], dx: 0, dy: 10 }, "live");
		persist("doc");

		expect(pdfStore.strokes("doc").find((s) => s.id === "s2")!.points[0]!.y, "precondition: the move landed in the store").toBe(90);
		expect(a!.refresh, "pane A is the one drawing; main does not refresh it").not.toHaveBeenCalled();
		expect(b!.refresh, "the idle second pane on the same PDF was told to repaint").toHaveBeenCalled();
	});
});

describe("one pane open: the end of a gesture costs the save and nothing else", () => {
	it("never walks the pane list when there is no other pane", async () => {
		made.length = 0;
		const pdfStore = new PdfInkStore();
		pdfStore.attachHost({
			load: async (id: string) => ({ data: { ...emptyPage(id), surface: "pdf", strokes: [stroke("s1", 10)] } }),
			schedule: () => {},
			notice: () => {},
		} as never);
		await pdfStore.ensureLoaded("doc");
		const save = vi.spyOn(pdfStore, "save");
		const win = { setTimeout, clearTimeout, requestAnimationFrame: () => 0 };
		const root = { isConnected: true, ownerDocument: { defaultView: win } } as unknown as HTMLElement;
		const leaves = [{ view: { containerEl: root, file: { path: "a.pdf" } } }];
		const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
		plugin.app = { workspace: { getLeavesOfType: (t: string) => (t === "pdf" ? leaves : []) } };
		plugin.pdfInk = new Map();
		plugin.pdfIds = new Map();
		plugin.pdfFiles = new Map();
		plugin.pdfStore = pdfStore;
		plugin.pdfCalibration = false;
		plugin.settings = { inkPdfColorMode: "auto" };
		plugin.resolvePdfId = (): Promise<void> => Promise.resolve();
		(plugin as unknown as { syncPdfControllers(): void }).syncPdfControllers();
		expect(made.length, "precondition: one controller").toBe(1);
		(plugin.pdfIds as Map<HTMLElement, string>).set(root, "doc");
		// A pane list that cannot be walked: any loop over it throws.
		class Unwalkable<K, V> extends Map<K, V> {
			override [Symbol.iterator](): IterableIterator<[K, V]> {
				throw new Error("walked the pane list with one pane open");
			}
		}
		plugin.pdfInk = new Unwalkable(plugin.pdfInk as Map<HTMLElement, unknown>);
		const persist = made[0]!.args[8] as (id: string) => void;
		persist("doc");
		expect(save).toHaveBeenCalledWith("doc");
	});
});
