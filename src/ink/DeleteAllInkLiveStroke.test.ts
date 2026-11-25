/**
 * "Delete all ink on this PDF" confirmed while a stroke is still being drawn on that PDF.
 *
 * The wipe awaits its trash copy and the copy's read back (DeleteAllInk.ts, deleteAllPdfInk). A stroke begun in
 * that wait is not in the store yet, so the check that the ink did not change during the copy passes, and the clear
 * then calls forgetHistory on every pane on the PDF. forgetHistory starts by abandoning the live stroke
 * (PdfInkTools.ts, `router.abandonActiveStroke()`): the stroke is dropped, never saved, not in the copy, and the rest
 * of that contact draws nothing. These cells hold the user's side of it: a stroke open on the PDF when the clear would
 * run is never dropped. Delete all is refused with nothing deleted, in the words it already uses when the ink changed
 * during the copy, and the stroke's lift then saves it beside the old ink.
 *
 * Production code driven: HandwritingPlugin.prototype.deleteAllPdfInk over the real PageStore and PdfInkStore wired
 * as main.ts wires them, and the real PdfInkController built, mounted and identified by syncPdfControllers and
 * resolvePdfId, with its pen driven at the penDown/penRaw/penUp seam. Fakes: an in-memory adapter whose trash write
 * the cell holds open, the leaves, the viewer probe, the page's DOM, the tool strip and the router. The router is
 * built by bindTo in a sync these cells never let run, so it is supplied, as PdfSwitchLiveStrokeDropped.test.ts
 * supplies it: it holds the pen contact from the pen-down, abandonActiveStroke lets the contact go and says whether
 * a stroke was torn down, and the pen's lift reaches penUp only while the router still holds the contact, as a
 * pointerup does (an abandoned contact's lift is never routed: InlinePenRouterEnd.ts, abandonActiveStroke).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ current: null as unknown, notices: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			probe.notices.push(message);
		}
	},
}));
vi.mock("../pdf/PdfViewerProbe", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));
vi.mock("../inline/MobileTools", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	MobileTools: class {
		setCorner() {}
		refresh() {}
		setInking() {}
		closeInkSliders() {}
		stale() {
			return false;
		}
		destroy() {}
	},
}));

import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { resetTipModeForTest } from "../inline/TipMode";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "./Stroke";
import type { PenSample } from "../input/PointerRouter";

/** The refusal the wipe already gives when the ink changed during its copy (DeleteAllInk.ts:95-96). */
const CHANGED =
	"Handwriting: the ink changed while its backup was being made. nothing was deleted. run Delete all ink again if you still want to remove it.";

const A = "Lecture A.pdf";
const B = "Lecture B.pdf";

function stroke(id: string, x: number): InkStroke {
	return {
		id,
		page: 1,
		tool: "pen",
		color: "#111111",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

const sample = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/** A canvas whose context takes every call, as in PdfTurnMidStroke.test.ts. */
function fakeCanvas(parent: unknown): Record<string, unknown> {
	const ctx = new Proxy({} as Record<string, unknown>, {
		get: (t, p) => (p in t ? t[p as string] : () => undefined),
		set: (t, p, v) => {
			t[p as string] = v;
			return true;
		},
	});
	const c: Record<string, unknown> = {
		width: 300,
		height: 150,
		parentElement: parent,
		style: {},
		setAttribute: () => {},
		remove() {
			c.parentElement = null;
		},
		getContext: () => ctx,
		setCssStyles: () => {},
		setCssProps: () => {},
		toggleClass: () => {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		addEventListener: () => {},
	};
	return c;
}

beforeEach(() => {
	resetTipModeForTest();
	probe.notices = [];
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("Element", class {});
	vi.stubGlobal("ResizeObserver", NoopObserver);
	vi.stubGlobal("MutationObserver", NoopObserver);
});
afterEach(() => {
	for (const controller of mounted.splice(0)) controller.unmount();
	probe.current = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const mounted: Array<{ unmount(): void }> = [];

/** A trash write the cell holds open until it lets it go: the wait in which the stroke is begun. */
interface Held {
	path: string;
	bytes: string;
	release: () => void;
}

class HeldTrashAdapter extends FakeAdapter {
	hold = false;
	readonly held: Held[] = [];
	private waiting: ((h: Held) => void) | null = null;

	/** The first held trash write, awaited whether or not it has arrived. */
	firstHeld(): Promise<Held> {
		const h = this.held[0];
		if (h) return Promise.resolve(h);
		return new Promise<Held>((resolve) => {
			this.waiting = resolve;
		});
	}

	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		const files = [...this.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
		return { files, folders: [] };
	}

	override async write(path: string, bytes: string): Promise<void> {
		if (this.hold && path.includes("/trash/")) {
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const h: Held = { path, bytes, release };
			this.held.push(h);
			this.waiting?.(h);
			this.waiting = null;
			await gate;
		}
		await super.write(path, bytes);
	}
}

type Pen = {
	penDown(s: PenSample): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
	builder: unknown;
	router: unknown;
	history: { depth: { done: number; undone: number } };
};

function harness() {
	const adapter = new HeldTrashAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	// Two different files, so two different ids.
	const bytes = (path: string) =>
		new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + (path === A ? "a" : "b").repeat(4000) + "\n%%EOF\n");
	type Leaf = { view: { containerEl: HTMLElement; file: { path: string } } };
	const leaves: Leaf[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: async (file: { path: string }) => bytes(file.path).slice().buffer,
			getFileByPath: (p: string) => (p === A || p === B ? { path: p } : null),
		},
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app,
		store,
		pdfStore,
		settings: { inkPdfColorMode: "auto" },
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
	});

	/** A pane the cell does not draw in: a stub controller, idle or not as the cell says, and the real resolvePdfId. */
	async function openStub(path: string, idle: boolean) {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory: vi.fn(), idle };
		leaves.push({ view: { containerEl: root, file: { path } } });
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		return { root, controller, id: plugin.pdfIds.get(root) as string };
	}

	/** The pane the pen is in: the sweep builds, mounts and identifies its real controller. */
	async function openReal(path: string) {
		const pageEl: Record<string, unknown> = {
			clientWidth: 600,
			clientHeight: 800,
			getAttribute: () => null,
			querySelector: () => null,
			querySelectorAll: () => [],
			createEl: () => fakeCanvas(pageEl),
			appendChild: () => {},
			setCssStyles: () => {},
		};
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			clientWidth: 1600,
			clientHeight: 1200,
			classList: { add: () => {}, remove: () => {}, contains: () => false },
			querySelector: (sel: string) => (/div\.page\[data-page-number="1"\]/.test(sel) ? pageEl : null),
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		probe.current = {
			scroller,
			scaleFactor: 1,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = {
			devicePixelRatio: 1,
			navigator: { userAgent: "test", platform: "", maxTouchPoints: 0 },
			// Captured and never run: no repaint happens inside a cell.
			setTimeout: () => 0,
			clearTimeout: () => {},
			requestAnimationFrame: () => 0,
			cancelAnimationFrame: () => {},
			getComputedStyle: () => ({ position: "relative" }),
			getSelection: () => null,
		};
		const root = {
			isConnected: true,
			ownerDocument: { defaultView: win },
			addEventListener: () => {},
			removeEventListener: () => {},
			classList: { add: () => {}, remove: () => {}, contains: () => false },
			querySelector: () => null,
			contains: () => false,
		} as unknown as HTMLElement;
		leaves.push({ view: { containerEl: root, file: { path } } });
		plugin.syncPdfControllers();
		const controller = plugin.pdfInk.get(root);
		mounted.push(controller);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		await vi.waitFor(() => expect(plugin.pdfIds.get(root), "premise: the pane was identified").toBeDefined());
		await vi.waitFor(() => expect(pdfStore.inkReady(plugin.pdfIds.get(root)), "premise: the ink is loaded").toBe(true));
		const pen = controller as unknown as Pen;
		// The router, holding the contact from the pen-down until a lift or an abandon lets it go.
		let contact = false;
		pen.router = {
			abandonActiveStroke: () => {
				const had = contact;
				contact = false;
				return had;
			},
			finishActiveStroke: () => {},
			refreshRect: () => {},
			dispose: () => {},
		};
		return {
			root,
			pen,
			id: plugin.pdfIds.get(root) as string,
			/** Pen down on page 1 and six moves: a stroke being drawn. */
			down() {
				contact = true;
				pen.penDown(sample(100, 100));
				pen.penRaw([sample(110, 105), sample(120, 110), sample(130, 115), sample(140, 120), sample(150, 125), sample(160, 130)]);
			},
			/** Four more moves, the rest of the contact. */
			more() {
				pen.penRaw([sample(170, 135), sample(180, 140), sample(190, 145), sample(200, 150)]);
			},
			/** The pen leaves the glass: penUp runs only if the router still holds the contact. */
			lift() {
				if (!contact) return;
				contact = false;
				pen.penUp();
			},
		};
	}

	const inkPath = (id: string) => `.handwriting/${id}.json`;
	const ids = (id: string) => pdfStore.strokes(id).map((s) => s.id);
	/** What the ink file on disk holds now, read by a second store: saved, not only on screen. */
	async function onDisk(id: string): Promise<string[]> {
		const reader = new PdfInkStore();
		reader.attachHost({ load: (pageId) => store.load(pageId), schedule: () => {}, notice: () => {} });
		await reader.ensureLoaded(id);
		return reader.strokes(id).map((s) => s.id);
	}
	const trashIds = (path: string, id: string) => parsePage(adapter.files.get(path)!, id).data.strokes.map((s) => s.id);
	return { adapter, store, pdfStore, plugin, openStub, openReal, inkPath, ids, onDisk, trashIds };
}

describe("Delete all ink on a PDF confirmed while a stroke is being drawn on it", () => {
	it("the pen is in the only pane on the PDF: nothing is deleted, and the stroke's lift saves it beside the old ink", async () => {
		const h = harness();
		const a = await h.openReal(A);
		h.pdfStore.replaceAll(a.id, [stroke("a1", 10)]);
		await h.store.flush();
		expect(await h.onDisk(a.id), "premise: the old ink is saved").toEqual(["a1"]);

		// Confirmed; the trash copy is held open, and the stroke begins in that wait.
		h.adapter.hold = true;
		const deletion = h.plugin.deleteAllPdfInk(a.id) as Promise<void>;
		const held = await h.adapter.firstHeld();
		a.down();
		expect(a.pen.builder, "premise: the stroke is being drawn").not.toBeNull();
		expect(h.ids(a.id), "premise: the stroke is not in the store yet").toEqual(["a1"]);

		held.release();
		await deletion;
		a.more();
		a.lift();
		await h.store.flush();

		const now = h.ids(a.id);
		expect(now.length, "the store holds the old ink and the stroke").toBe(2);
		expect(now[0], "the old ink is kept").toBe("a1");
		expect(await h.onDisk(a.id), "the old ink and the stroke are saved").toEqual(now);
		expect(probe.notices, "refused in the shipped words, nothing said removed").toEqual([CHANGED]);
		expect(a.pen.history.depth, "the stroke is one step on the pane's undo").toEqual({ done: 1, undone: 0 });
		// The copy that completed stays where it is, a real copy of the old ink.
		expect(h.trashIds(held.path, a.id), "the trash copy holds the old ink").toEqual(["a1"]);
	});

	it("the pen is in a second pane on the same PDF: nothing is deleted, and the stroke's lift saves it beside the old ink", async () => {
		const h = harness();
		// An idle pane on A first, so the pane with the pen is the second pane on the PDF.
		const first = await h.openStub(A, true);
		const a = await h.openReal(A);
		expect(a.id, "premise: both panes show the same PDF").toBe(first.id);
		expect([...h.plugin.pdfInk.keys()].indexOf(a.root), "premise: the pen's pane is the second pane").toBe(1);
		h.pdfStore.replaceAll(a.id, [stroke("a1", 10)]);
		await h.store.flush();

		h.adapter.hold = true;
		const deletion = h.plugin.deleteAllPdfInk(a.id) as Promise<void>;
		const held = await h.adapter.firstHeld();
		a.down();
		held.release();
		await deletion;
		a.more();
		a.lift();
		await h.store.flush();

		const now = h.ids(a.id);
		expect(now.length, "the store holds the old ink and the stroke").toBe(2);
		expect(now[0], "the old ink is kept").toBe("a1");
		expect(await h.onDisk(a.id), "the old ink and the stroke are saved").toEqual(now);
		expect(probe.notices, "refused in the shipped words, nothing said removed").toEqual([CHANGED]);
		expect(first.controller.forgetHistory, "the idle pane's undo is not forgotten").not.toHaveBeenCalled();
	});

	it("no pane is drawing: Delete all removes the ink as it does today, with the copy and the count", async () => {
		const h = harness();
		const first = await h.openStub(A, true);
		const a = await h.openReal(A);
		h.pdfStore.replaceAll(a.id, [stroke("a1", 10)]);
		// A stroke drawn and lifted before the command: on the pane's undo, and the lift in this rig commits.
		a.down();
		a.lift();
		await h.store.flush();
		const before = h.ids(a.id);
		expect(before.length, "premise: the lift saved the stroke").toBe(2);
		expect(a.pen.history.depth, "premise: the stroke is on the pane's undo").toEqual({ done: 1, undone: 0 });

		h.adapter.hold = true;
		const deletion = h.plugin.deleteAllPdfInk(a.id) as Promise<void>;
		const held = await h.adapter.firstHeld();
		held.release();
		await deletion;
		await h.store.flush();

		expect(probe.notices).toEqual([`Handwriting: removed 2 strokes. A copy is kept in ${held.path}.`]);
		expect(h.ids(a.id), "the store is empty").toEqual([]);
		expect(await h.onDisk(a.id), "the ink file is empty").toEqual([]);
		expect(h.trashIds(held.path, a.id), "the trash copy holds what was removed").toEqual(before);
		expect(a.pen.history.depth, "the pane's undo is forgotten").toEqual({ done: 0, undone: 0 });
		expect(first.controller.forgetHistory, "every pane on the PDF forgets its undo").toHaveBeenCalledTimes(1);
	});

	it("a pane drawing on another PDF: Delete all on this one goes ahead and leaves that pane alone", async () => {
		const h = harness();
		const other = await h.openStub(B, false);
		const a = await h.openReal(A);
		expect(a.id, "premise: two documents").not.toBe(other.id);
		h.pdfStore.replaceAll(a.id, [stroke("a1", 10)]);
		h.pdfStore.replaceAll(other.id, [stroke("b1", 60)]);
		await h.store.flush();

		h.adapter.hold = true;
		const deletion = h.plugin.deleteAllPdfInk(a.id) as Promise<void>;
		const held = await h.adapter.firstHeld();
		held.release();
		await deletion;
		await h.store.flush();

		expect(probe.notices).toEqual([`Handwriting: removed 1 stroke. A copy is kept in ${held.path}.`]);
		expect(h.ids(a.id), "this PDF's ink is removed").toEqual([]);
		expect(h.ids(other.id), "the other PDF's ink is untouched").toEqual(["b1"]);
		expect(other.controller.forgetHistory, "the other PDF's pane keeps its undo").not.toHaveBeenCalled();
	});
});
