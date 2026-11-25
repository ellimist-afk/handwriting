/**
 * A lasso cut survives an app restart.
 *
 * A cut is a copy and a delete. The copy lived only in module state, so if Obsidian restarted between the cut and the
 * paste (a phone closing the app, Reload app, a plugin update, a crash) the delete had been saved and the ink was in no
 * note and on no clipboard. The cut's ink is now kept on this device, in the vault's own local store, before the delete,
 * and read back when the store is registered at the next start. The next copy or cut replaces or clears it. A plain copy
 * is never kept, so its old marker still gets the restart notice.
 *
 * A restart here is vi.resetModules and fresh imports: the clipboard module starts with nothing held and no token, as a
 * new process does, and the store is registered again as onloadDevice does. The registration is an optional call, so at
 * a build without it these cells fail at their assertion lines, not at an import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	Notice: class {
		messageEl = { isConnected: true };
		constructor(message: string) {
			notices.push(message);
		}
		hide(): void {}
		setMessage(): void {}
	},
}));

import type { InkStroke } from "../ink/Stroke";
import { emptyPage, serializePage } from "../model/PageData";
import onloadSource from "../PluginOnload.ts?raw";
import clipboardSource from "./InkClipboard.ts?raw";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const globals = globalThis as unknown as Record<string, unknown>;
globals.ResizeObserver ??= NoopObserver;
globals.MutationObserver ??= NoopObserver;

const KEY = "handwriting-ink-cut";
const RESTART_NOTICE = "Handwriting: that ink was copied before the app restarted";

type DeviceStore = { load(key: string): unknown; save(key: string, value: unknown): void };
type Seams = { setInkClipboardStore?: (store: DeviceStore | null) => void };

/** Obsidian's per-vault local store, faked: save(key, null) clears. Options model the ways it fails. */
class FakeDevice implements DeviceStore {
	readonly values = new Map<string, unknown>();
	readonly saves: { key: string; value: unknown }[] = [];
	throwOnSave = false;
	/** Load hands back a JSON string, as some Obsidian versions do (PluginOnload.ts:66-70). */
	asString = false;
	/** Total characters the store holds before a write throws; null = no limit. */
	quota: number | null = null;
	onSave: ((key: string, value: unknown) => void) | null = null;
	load(key: string): unknown {
		if (!this.values.has(key)) return null;
		const v = this.values.get(key);
		return this.asString && typeof v !== "string" ? JSON.stringify(v) : v;
	}
	save(key: string, value: unknown): void {
		this.saves.push({ key, value });
		if (value === null) {
			this.values.delete(key);
			return;
		}
		this.onSave?.(key, value);
		if (this.throwOnSave) throw new Error("QuotaExceededError");
		if (this.quota !== null) {
			let used = JSON.stringify(value).length;
			for (const [k, v] of this.values) if (k !== key) used += JSON.stringify(v).length;
			if (used > this.quota) throw new Error("QuotaExceededError");
		}
		this.values.set(key, value);
	}
}

/** One run of the app: fresh modules, the device store registered as at onload. */
async function boot(device: FakeDevice) {
	vi.resetModules();
	const clip = await import("./InkClipboard");
	const overlayMod = await import("./InkOverlay");
	const pdfMod = await import("../pdf/PdfInkController");
	const history = await import("../pdf/PdfInkHistory");
	(clip as unknown as Seams).setInkClipboardStore?.(device);
	return { clip, overlayMod, pdfMod, history };
}
type Run = Awaited<ReturnType<typeof boot>>;

function stroke(id: string, x: number, page?: number): InkStroke {
	const points = [0, 10, 20].map((v, i) => ({ x: x + v, y: 160 + v, pressure: 0.5, t: i * 8 }));
	return {
		id,
		tool: "pen",
		color: "#112233",
		width: 4,
		points,
		bbox: { x: x - 2, y: 158, width: 24, height: 24 },
		createdAt: 1,
		...(page !== undefined ? { page } : {}),
	};
}

/** A real overlay on a note, host chrome replaced (PasteFontRef.test.ts's rig). */
function noteRig(run: Run, path: string) {
	const noop = (): void => undefined;
	const scrollDOM = {
		clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0,
		getBoundingClientRect: () => ({ left: 0, top: 0 }), scrollLeft: 0, scrollTop: 0,
	};
	// winRef is a getter over the view's document window, so the clipboard and the pixel ratio go on that window.
	const dom = {
		ownerDocument: {
			defaultView: {
				getComputedStyle: () => ({ position: "relative" }),
				navigator: { clipboard: { writeText: async () => undefined } },
				devicePixelRatio: 1,
			},
		},
		parentElement: null,
		closest: (selector: string): unknown => (selector === ".markdown-source-view" ? root : null),
	};
	const root = { ownerDocument: dom.ownerDocument, querySelector: () => dom };
	let fileReady = false;
	const view = {
		dom, scrollDOM,
		state: { field: () => (fileReady ? { file: { path } } : undefined), selection: { main: { empty: true } } },
		dispatch: noop,
	};
	const o = new run.overlayMod.InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	fileReady = true;
	o.container = { nodeType: 1, remove: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	o.mobileTools = null;
	o.scheduleRepaint = noop;
	o.repaintPath = noop;
	o.redrawSelectionUI = noop;
	o.updateExtent = noop;
	o.syncCamera = noop;
	return o as unknown as import("./InkOverlay").InkOverlayPlugin & { selection: { selectExactly(ids: string[]): void } };
}

/** Ink on a note, all of it lassoed and cut. */
async function cutOnNote(run: Run, path: string, strokes: InkStroke[], fontRef: number | null = 16) {
	await run.overlayMod.inlineInk.ensureLoaded(path);
	if (fontRef !== null) run.overlayMod.inlineInk.setFontRefPx(path, fontRef);
	run.overlayMod.inlineInk.applyAdd(path, strokes);
	const rig = noteRig(run, path);
	rig.selection.selectExactly(strokes.map((s) => s.id));
	const outcome = rig.cutSelectedInk();
	return { outcome, marker: run.clip.inkClipboardMarker(), left: run.overlayMod.inlineInk.strokes(path).length };
}

async function copyOnNote(run: Run, path: string, strokes: InkStroke[]) {
	await run.overlayMod.inlineInk.ensureLoaded(path);
	run.overlayMod.inlineInk.applyAdd(path, strokes);
	const rig = noteRig(run, path);
	rig.selection.selectExactly(strokes.map((s) => s.id));
	expect(rig.copySelectedInk(), "premise: the copy took the strokes").toBe(strokes.length);
	return run.clip.inkClipboardMarker();
}

async function targetNote(run: Run, path: string, fontRef: number | null) {
	await run.overlayMod.inlineInk.ensureLoaded(path);
	if (fontRef !== null) run.overlayMod.inlineInk.setFontRefPx(path, fontRef);
	return noteRig(run, path);
}

function ctrlV(text: string) {
	return {
		clipboardData: { getData: () => text },
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
	} as unknown as ClipboardEvent;
}

/** A PDF controller over one page of ink (CX5Clipboard.test.ts's rig), its DOM-facing steps stubbed. */
function pdfRig(run: Run, ink: InkStroke[]) {
	const state = { ink };
	const win = { navigator: { clipboard: { writeText: async () => undefined } }, devicePixelRatio: 1 } as unknown as Window;
	const said: string[] = [];
	const controller = new run.pdfMod.PdfInkController(
		{ querySelector: () => null } as unknown as HTMLElement,
		win,
		() => state.ink,
		() => "pdf-id",
		() => state.ink,
		(op) => {
			state.ink = run.history.applyOp(state.ink, op);
		},
		() => {},
		(m: string) => void said.push(m),
		() => {},
		() => false,
		() => "darken",
		() => true,
		() => false,
		() => "doc.pdf"
	);
	const c = controller as unknown as Record<string, unknown>;
	c.refresh = () => undefined;
	c.refreshStrip = () => undefined;
	c.drawLasso = () => undefined;
	c.frameBox = () => null;
	c.probe = () => null;
	return { controller, state, said, access: c as unknown as { selected: string[]; selectionPage: number } };
}

const place = (s: InkStroke) => s.points.map((p) => [p.x, p.y, p.pressure, p.t]);

let device: FakeDevice;
beforeEach(() => {
	device = new FakeDevice();
	notices.length = 0;
});
afterEach(() => vi.resetModules());

describe("a note cut pastes after a restart", { timeout: 60_000 }, () => {
	it("C1 the paste command puts the cut ink back, font size kept", async () => {
		const p1 = await boot(device);
		const cut = await cutOnNote(p1, "c1-source.md", [stroke("a", 80), stroke("b", 200), stroke("c", 320)]);
		expect(cut.outcome, "premise: a cut").toEqual({ kind: "cut", count: 3 });
		expect(cut.left, "premise: the note holds none of it").toBe(0);

		const p2 = await boot(device);
		const target = await targetNote(p2, "c1-target.md", 20);
		expect(target.pasteInkHere(), "after a restart the paste command pastes the cut").toBe(3);
		const landed = p2.overlayMod.inlineInk.strokes("c1-target.md");
		expect(landed.map((s) => s.points[0]!.x), "16px source into a 20px note scales by 1.25").toEqual([100, 250, 400]);
		expect(landed[0]!.width).toBe(5);
	});

	it("C2 Ctrl+V with the old marker pastes it, no restart notice", async () => {
		const p1 = await boot(device);
		const cut = await cutOnNote(p1, "c2-source.md", [stroke("a", 80), stroke("b", 200), stroke("c", 320)], null);
		expect(cut.marker, "premise: the cut left a marker").not.toBeNull();

		const p2 = await boot(device);
		const target = await targetNote(p2, "c2-target.md", null);
		expect(target.handlePaste(ctrlV(cut.marker!)), "premise: our marker is ours").toBe(true);
		expect(notices, "the old marker is not refused").not.toContain(RESTART_NOTICE);
		const landed = p2.overlayMod.inlineInk.strokes("c2-target.md");
		expect(landed.map(place), "the cut's own points land").toEqual(
			[stroke("a", 80), stroke("b", 200), stroke("c", 320)].map(place)
		);
	});

	it("C4 the cut ink is stored before the delete takes it from the note", async () => {
		const p1 = await boot(device);
		const atSave: number[] = [];
		device.onSave = (key) => {
			if (key === KEY) atSave.push(p1.overlayMod.inlineInk.strokes("c4-source.md").length);
		};
		await cutOnNote(p1, "c4-source.md", [stroke("a", 80), stroke("b", 200), stroke("c", 320)]);
		expect(atSave, "one store write, while the note still held all 3").toEqual([3]);
	});
});

describe("a PDF cut pastes after a restart", { timeout: 60_000 }, () => {
	it("C3 the stroke goes back on its page, as PDF ink", async () => {
		const p1 = await boot(device);
		const r1 = pdfRig(p1, [stroke("pdf-ink", 100, 1)]);
		r1.access.selected = ["pdf-ink"];
		r1.access.selectionPage = 1;
		expect(r1.controller.cutSelection(), "premise: a PDF cut").toBe(1);
		expect(r1.state.ink, "premise: the page holds none of it").toEqual([]);

		const p2 = await boot(device);
		expect(p2.clip.inkCopiedFrom(), "after a restart the clipboard holds PDF ink").toBe("pdf");
		const r2 = pdfRig(p2, []);
		r2.controller.pasteFromClipboard();
		expect(r2.state.ink.map((s) => s.page), "pasted on page 1").toEqual([1]);
		// Back into the PDF it was cut from (same id, same file), so it steps 16px off, as a paste into the source does
		// in one session: the paste is the session's own, not a new placement.
		const stepped = [stroke("pdf-ink", 100, 1)].map(place).map((pts) => pts.map(([x, y, p, t]) => [x! + 16, y! + 16, p, t]));
		expect(r2.state.ink.map(place), "the cut's points, one stagger off").toEqual(stepped);
	});
});

describe("the stored cut is the session clipboard, never older", { timeout: 60_000 }, () => {
	it("C5a a cut, then a plain copy: after a restart nothing is held and both markers get the restart notice", async () => {
		const p1 = await boot(device);
		const cut = await cutOnNote(p1, "c5a-cut.md", [stroke("a", 80)]);
		const copied = await copyOnNote(p1, "c5a-copy.md", [stroke("b", 200)]);

		const p2 = await boot(device);
		expect(p2.clip.clipboardSize(), "the copy cleared the stored cut").toBe(0);
		const target = await targetNote(p2, "c5a-target.md", null);
		target.handlePaste(ctrlV(copied!));
		target.handlePaste(ctrlV(cut.marker!));
		expect(notices).toEqual([RESTART_NOTICE, RESTART_NOTICE]);
		expect(p2.overlayMod.inlineInk.strokes("c5a-target.md")).toEqual([]);
	});

	it("C5b cut A, then cut B: after a restart B pastes, not A", async () => {
		const p1 = await boot(device);
		await cutOnNote(p1, "c5b-a.md", [stroke("a", 80)]);
		await cutOnNote(p1, "c5b-b.md", [stroke("b", 500)]);

		const p2 = await boot(device);
		const target = await targetNote(p2, "c5b-target.md", null);
		expect(target.pasteInkHere(), "after a restart the later cut pastes").toBe(1);
		expect(p2.overlayMod.inlineInk.strokes("c5b-target.md").map(place)).toEqual([stroke("b", 500)].map(place));
	});

	it("C6 a plain copy is not kept: after a restart nothing is held, its marker gets the restart notice", async () => {
		const p1 = await boot(device);
		const marker = await copyOnNote(p1, "c6-copy.md", [stroke("a", 80)]);
		expect(device.values.has(KEY), "a copy writes nothing").toBe(false);

		const p2 = await boot(device);
		expect(p2.clip.clipboardSize()).toBe(0);
		const target = await targetNote(p2, "c6-target.md", null);
		target.handlePaste(ctrlV(marker!));
		expect(notices).toEqual([RESTART_NOTICE]);
	});
});

describe("a store that fails never blocks or changes the cut", { timeout: 60_000 }, () => {
	it("C7 the store's write throws: the cut still deletes and answers cut", async () => {
		device.throwOnSave = true;
		const p1 = await boot(device);
		const cut = await cutOnNote(p1, "c7-source.md", [stroke("a", 80), stroke("b", 200)]);
		expect(cut.outcome).toEqual({ kind: "cut", count: 2 });
		expect(cut.left).toBe(0);
		expect(p1.clip.clipboardSize(), "the session clipboard still holds it").toBe(2);
		const p2 = await boot(device);
		expect(p2.clip.clipboardSize()).toBe(0);
	});

	it("C7b cut A kept, cut B's write throws: after a restart nothing is held, never A", async () => {
		const p1 = await boot(device);
		const a = await cutOnNote(p1, "c7b-a.md", [stroke("a", 80)]);
		device.throwOnSave = true;
		const b = await cutOnNote(p1, "c7b-b.md", [stroke("b", 500)]);
		expect(b.outcome).toEqual({ kind: "cut", count: 1 });
		device.throwOnSave = false;

		const p2 = await boot(device);
		expect(p2.clip.clipboardSize(), "A is never brought back").toBe(0);
		const target = await targetNote(p2, "c7b-target.md", null);
		target.handlePaste(ctrlV(a.marker!));
		target.handlePaste(ctrlV(b.marker!));
		expect(notices).toEqual([RESTART_NOTICE, RESTART_NOTICE]);
	});

	it("C10 a cut over the size budget stores nothing and still cuts", async () => {
		const points = Array.from({ length: 100_000 }, (_, i) => ({ x: i % 1000, y: Math.floor(i / 1000), pressure: 0.5, t: i }));
		const big: InkStroke = { ...stroke("big", 0), points, bbox: { x: 0, y: 0, width: 1000, height: 100 } };
		const p1 = await boot(device);
		const cut = await cutOnNote(p1, "c10-source.md", [big]);
		expect(cut.outcome).toEqual({ kind: "cut", count: 1 });
		expect(cut.left).toBe(0);
		expect(device.values.has(KEY), "nothing stored over the budget").toBe(false);
		expect(p1.clip.clipboardSize(), "the session clipboard still holds it").toBe(1);
	});

	it("C11 a nearly full store: the cut's write fails and takes no room from the next writer", async () => {
		device.quota = 2_000;
		device.values.set("other-writer", "x".repeat(1_800));
		const p1 = await boot(device);
		const cut = await cutOnNote(p1, "c11-source.md", [stroke("a", 80), stroke("b", 200), stroke("c", 320)]);
		expect(cut.outcome).toEqual({ kind: "cut", count: 3 });
		expect(device.values.has(KEY), "the cut did not land").toBe(false);
		expect(() => device.save("pending-deletes", ["a.pdf"]), "a small write after it still fits").not.toThrow();
	});
});

/** A stored record by hand, in the shape the clipboard writes. */
function record(over: Record<string, unknown> = {}, strokes: InkStroke[] = [stroke("a", 80)]): Record<string, unknown> {
	return {
		v: 1,
		token: "tok-1",
		from: "note",
		sourcePath: "hand.md",
		sourceFile: null,
		sourceFontRefPx: null,
		page: serializePage({ ...emptyPage("ink-cut"), strokes }),
		...over,
	};
}

describe("reading the stored cut back", { timeout: 60_000 }, () => {
	it("C8a a record read back as an object is restored, its marker current", async () => {
		device.values.set(KEY, record());
		const p2 = await boot(device);
		expect(p2.clip.clipboardSize(), "restored").toBe(1);
		expect(p2.clip.markerIsCurrent("handwriting-ink/v1 tok-1 (1 stroke)")).toBe(true);
	});

	it("C8b a record read back as a JSON string is restored", async () => {
		device.values.set(KEY, JSON.stringify(record()));
		const p2 = await boot(device);
		expect(p2.clip.clipboardSize(), "restored from a string").toBe(1);
		const target = await targetNote(p2, "c8b-target.md", null);
		expect(target.pasteInkHere()).toBe(1);
	});

	it("C8c a cut kept through a store that reads back strings pastes after a restart", async () => {
		device.asString = true;
		const p1 = await boot(device);
		await cutOnNote(p1, "c8c-source.md", [stroke("a", 80)]);
		const p2 = await boot(device);
		const target = await targetNote(p2, "c8c-target.md", null);
		expect(target.pasteInkHere()).toBe(1);
	});

	const bad: [string, () => unknown][] = [
		["not JSON", () => "not json{"],
		["the page cut off", () => ({ ...record(), page: (record().page as string).slice(0, 40) })],
		["no strokes", () => record({}, [])],
		["a newer record", () => record({ v: 2 })],
		["a token that is not a string", () => record({ token: 7 })],
		["a source that is neither", () => record({ from: "slides" })],
		["a stroke with no width", () => record({ page: (record().page as string).replace('"width":4', '"width":"wide"') })],
	];
	for (const [name, value] of bad) {
		it(`C8 ${name}: nothing restored, the key cleared, no throw`, async () => {
			device.values.set(KEY, value());
			const p2 = await boot(device);
			expect(p2.clip.clipboardSize(), "nothing restored").toBe(0);
			expect(device.values.has(KEY), "the key is cleared").toBe(false);
		});
	}
});

describe("where it is kept", () => {
	it("C9 onloadDevice registers it through the vault's local store, and the clipboard writes nowhere else", () => {
		expect(onloadSource).toMatch(
			/setInkClipboardStore\(\{\s*load: \(key\) => this\.app\.loadLocalStorage\(key\)[^}]*save: \(key, value\) => this\.app\.saveLocalStorage\(key, value\),?\s*\}\)/
		);
		const clip = clipboardSource;
		expect(clip).not.toMatch(/saveData|\.vault\b|adapter|localStorage\./);
	});
});
