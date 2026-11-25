/**
 * A pane that opens another file while the pen is down on a PDF in it.
 *
 * The same leaf shows a second file (the file list, the quick switcher, Back
 * or Forward, or a sync tool replacing what the tab shows), and the layout
 * sweep sees the leaf's path change: it lets go of the old document's id and
 * calls forgetHistory (PdfClaims.ts, the `path !== "" && pdfFiles.get(root)
 * !== path` branch). The stroke in progress belonged to the PDF being left
 * and is dropped, never saved: keeping it would mean writing a partial stroke
 * into the document being left, and a wrong write there is wrong ink in a
 * saved file. These cells pin the drop as it stands: neither document is
 * written, on disk or in the store, and the stroke's live trail and the
 * strip's inking state are taken down.
 *
 * Production code driven: HandwritingPlugin.prototype.syncPdfControllers (it
 * builds and mounts the real PdfInkController, and runs the switch branch)
 * and resolvePdfId, over the real PageStore and PdfInkStore wired as main.ts
 * wires them. Fakes: an in-memory adapter, the leaves, the viewer probe, the
 * page's DOM, the tool strip and the router. The controller's pen is driven at
 * its penDown/penRaw seam, and the router (built by bindTo in a sync that never
 * runs here) is supplied, as PdfAbandonStrokeOnSwitch.test.ts supplies it: its
 * abandonActiveStroke answers true while the controller holds a stroke, as the
 * router answers with a pen on the glass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ current: null as unknown, inking: [] as boolean[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));
vi.mock("./PdfViewerProbe", async (importOriginal) => ({
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
		setInking(on: boolean) {
			probe.inking.push(on);
		}
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
import { PdfInkStore } from "./PdfInkStore";
import { resetTipModeForTest } from "../inline/TipMode";
import type { InkStroke } from "../ink/Stroke";
import type { PenSample } from "../input/PointerRouter";

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
	probe.inking = [];
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

function harness() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
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

	/** A second pane on B that the sweep leaves alone: a stub controller and the real resolvePdfId. */
	async function openStub(path: string) {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory() {}, idle: true };
		leaves.push({ view: { containerEl: root, file: { path } } });
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		return plugin.pdfIds.get(root) as string;
	}

	/** The pane under test on A: the sweep builds, mounts and identifies its real controller. */
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
		const leaf: Leaf = { view: { containerEl: root, file: { path } } };
		leaves.push(leaf);
		plugin.syncPdfControllers();
		const controller = plugin.pdfInk.get(root);
		mounted.push(controller);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		await vi.waitFor(() => expect(plugin.pdfIds.get(root), "premise: the pane on A was identified").toBeDefined());
		await vi.waitFor(() => expect(pdfStore.inkReady(plugin.pdfIds.get(root)), "premise: A's ink is loaded").toBe(true));
		return { root, leaf, controller, id: plugin.pdfIds.get(root) as string };
	}

	const inkPath = (id: string) => `.handwriting/${id}.json`;
	const ids = (id: string) => pdfStore.strokes(id).map((s) => s.id);
	const inkFiles = () => [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/")).sort();
	return { adapter, store, pdfStore, plugin, openStub, openReal, inkPath, ids, inkFiles };
}

describe("a pane that opens another file while the pen is down on a PDF", () => {
	it("drops the stroke: neither document is written on disk or in the store, and the live trail and the strip's inking are taken down", async () => {
		const h = harness();
		// B open in another pane, with saved ink.
		const idB = await h.openStub(B);
		h.pdfStore.replaceAll(idB, [stroke("b1", 60)]);
		// The pane under test on A, with saved ink.
		const a = await h.openReal(A);
		expect(a.id, "premise: A and B are two documents").not.toBe(idB);
		h.pdfStore.replaceAll(a.id, [stroke("a1", 10)]);
		await h.store.flush();
		const disk = { a: h.adapter.files.get(h.inkPath(a.id)), b: h.adapter.files.get(h.inkPath(idB)) };
		const files = h.inkFiles();
		expect([disk.a !== undefined, disk.b !== undefined], "premise: both documents' ink is on disk").toEqual([true, true]);

		// Every way the store is written, watched from the pen-down on.
		const writes: string[] = [];
		for (const name of ["replaceAll", "replaceAllLive", "applyLivePage", "save"] as const) {
			const real = (h.pdfStore[name] as (...args: unknown[]) => unknown).bind(h.pdfStore);
			vi.spyOn(h.pdfStore, name).mockImplementation(((...args: unknown[]) => {
				writes.push(`${name}(${String(args[0])})`);
				return real(...args);
			}) as never);
		}

		// Pen down on page 1 and six moves.
		const priv = a.controller as unknown as {
			penDown(s: PenSample): void;
			penRaw(s: PenSample[]): void;
			frame: unknown;
			builder: unknown;
			router: unknown;
			wetOn(page: number): { wet: { clearStroke(w: number, h: number): void }; tail: { clear(w?: number, h?: number): void } } | null;
		};
		priv.penDown(sample(100, 100));
		priv.penRaw([sample(110, 105), sample(120, 110), sample(130, 115), sample(140, 120), sample(150, 125), sample(160, 130)]);
		expect([priv.frame !== null, priv.builder !== null], "premise: the stroke is live on the page").toEqual([true, true]);
		expect(probe.inking, "premise: the strip went into inking at the pen-down").toEqual([true]);
		const pair = priv.wetOn(1);
		expect(pair, "premise: the stroke's live trail is on page 1").not.toBeNull();
		const wetCleared = vi.spyOn(pair!.wet, "clearStroke");
		const tailCleared = vi.spyOn(pair!.tail, "clear");
		// The pen was driven at the controller's seam, and the real router is built by bindTo inside a sync this rig never
		// lets run. So the router is supplied, as PdfAbandonStrokeOnSwitch.test.ts supplies it: its abandon says a stroke
		// was torn down while the controller holds one, as the router says with a pen on the glass.
		priv.router = {
			abandonActiveStroke: () => priv.builder !== null,
			finishActiveStroke: () => {},
			refreshRect: () => {},
			dispose: () => {},
		};

		// The same leaf shows B; the layout sweep runs.
		const leaf = a.leaf;
		leaf.view.file = { path: B };
		h.plugin.syncPdfControllers();

		expect([priv.frame, priv.builder], "the stroke is ended at the switch").toEqual([null, null]);
		expect([wetCleared.mock.calls.length, tailCleared.mock.calls.length], "the live trail is cleared off page 1 [wet, tail]").toEqual([1, 1]);
		expect(probe.inking, "the strip leaves inking").toEqual([true, false]);
		expect([h.ids(a.id), h.ids(idB)], "neither document's ink changed in the store [A, B]").toEqual([["a1"], ["b1"]]);

		// The pane takes B's id; the old id is let go, its write settles.
		await vi.waitFor(() => expect(h.plugin.pdfIds.get(a.root), "the pane is identified as B").toBe(idB));
		await h.pdfStore.settle();
		await h.store.flush();
		expect(writes, "nothing was written to the store from the pen-down on").toEqual([]);
		expect(h.ids(idB), "B's ink in the store").toEqual(["b1"]);
		expect([h.adapter.files.get(h.inkPath(a.id)) === disk.a, h.adapter.files.get(h.inkPath(idB)) === disk.b], "both documents' ink on disk is byte for byte as before [A, B]").toEqual([true, true]);
		expect(h.inkFiles(), "no ink file was added or removed").toEqual(files);
	});
});
