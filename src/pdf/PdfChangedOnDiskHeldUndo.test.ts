// Two panes on one inked PDF; the PDF changes on disk while the pen is down in the second pane. The change check skips
// the busy pane and leaves it on the old ink file with its undo ring, and the idle pane carries the old file's ink into
// the new one. An undo or redo the second pane makes before it is identified again acts on the old file, and the later
// carry adds only what the new file lacks and was never given: the step is lost, or an undone erase saves the whole
// stroke over its own pieces.
//
// Want, for every step: the press either makes the step or leaves the ink as it was, and what the pane shows right after
// the press is what the new file holds once the pane is identified again. The new file never holds a stroke together
// with its erased pieces. Pins: a lone busy pane, and two busy panes, where no carry was made, undo as today.
//
// The rig is the one in PdfChangedOnDiskKeepsInk.test.ts (synthetic vault; production identity, PDF store and
// PageStore), with the second pane's controller the real one syncPdfControllers builds (mount stubbed, as in
// PdfSnipDestination.test.ts), so each step runs through the production historyStep and op sink.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { PdfInkController } from "./PdfInkController";
import type { InkStroke } from "../ink/Stroke";
import type { InkOp } from "../inline/InkHistory";

// What the plugin told the user through Obsidian's Notice. The stub's Notice is an empty class, so it is replaced here.
const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			shown.push(message);
		}
	}
	return { ...actual, Notice };
});

// Taken before any cell fakes the clock: the late digest waits on the real one.
const realTimeout = globalThis.setTimeout;

/** Make the platform digest land `ms` of real time late, as a loaded machine's thread pool can. */
function lateDigest(ms: number) {
	const subtle = globalThis.crypto.subtle;
	const digest = subtle.digest.bind(subtle);
	vi.spyOn(subtle, "digest").mockImplementation(async (algorithm, data) => {
		await new Promise((resolve) => realTimeout(resolve, ms));
		return digest(algorithm, data);
	});
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
	vi.spyOn(PdfInkController.prototype, "mount").mockImplementation(() => {});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string, x = 10): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 10, pressure: 0.5, t: 0 }, { x: x + 10, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

/** Each stroke as its id and where it starts, sorted: a move changes the place, not the id. */
const shape = (strokes: readonly InkStroke[]) => strokes.map((s) => `${s.id}@${s.points[0]!.x},${s.points[0]!.y}`).sort();

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	const bytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");
	return { adapter, pdfs: new Map([["Paper.pdf", bytes]]) };
}

/** A re-export: one head byte of the PDF changes, so its ink id changes. A second re-export changes another byte. */
function mutate(v: ReturnType<typeof vault>, at = 100) {
	const after = v.pdfs.get("Paper.pdf")!.slice();
	after[at] = 121;
	v.pdfs.set("Paper.pdf", after);
}

/** The second pane: the real controller, a committed gesture recorded for undo, the pen held down or lifted, Ctrl+Z. */
interface Pen {
	root: HTMLElement;
	controller: PdfInkController;
	emit(op: InkOp): void;
	down(held: boolean): void;
	undo(): boolean;
	redo(): boolean;
}

function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
			vault: {
				adapter: v.adapter,
				readBinary: async (file: { path: string }) => v.pdfs.get(file.path)!.slice().buffer,
				getFileByPath: (path: string) => (v.pdfs.has(path) ? { path, extension: "pdf" } : null),
			},
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
		pdfCalibration: false, settings: { inkPdfColorMode: "auto" },
	});
	// Every identification, so a cell can wait for the one syncPdfControllers starts detached.
	const resolutions: Promise<void>[] = [];
	const resolve = plugin.resolvePdfId as (...args: unknown[]) => Promise<void>;
	plugin.resolvePdfId = function (this: unknown, ...args: unknown[]) {
		const done = resolve.apply(this, args);
		resolutions.push(done);
		return done;
	};
	// Every change check, the retry a held pane's settle starts included.
	const passes: Promise<void>[] = [];
	const check = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const pass = check.apply(this, args);
		passes.push(pass);
		return pass;
	};
	/** A pane whose controller is a stand-in: it draws nothing, it is idle unless a cell says not. */
	async function openPlain() {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true };
		const leaf = { view: { file: { path: "Paper.pdf" }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, "Paper.pdf");
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		return { root, controller };
	}
	/** A pane opened the way the plugin opens one: syncPdfControllers builds its controller and identifies it. */
	async function openPen(): Promise<Pen> {
		const win = { devicePixelRatio: 1, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {} };
		const root = { isConnected: true, ownerDocument: { defaultView: win } } as unknown as HTMLElement;
		leaves.push({ view: { file: { path: "Paper.pdf" }, containerEl: root } });
		const before = resolutions.length;
		plugin.syncPdfControllers();
		expect(resolutions.length, "syncPdfControllers identified the new pane").toBe(before + 1);
		await resolutions[resolutions.length - 1];
		const controller = plugin.pdfInk.get(root) as PdfInkController;
		expect(controller, "a real controller").toBeInstanceOf(PdfInkController);
		expect(plugin.pdfIds.get(root), "production resolution bound an id").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		const pen = controller as unknown as { emit(op: InkOp): boolean; historyStep(redo: boolean): boolean };
		// The pen held on the glass: a stroke, an erase or a lasso is live. Only `idle` is read for it here.
		let held = false;
		Object.defineProperty(controller, "idle", { configurable: true, get: () => !held });
		return {
			root,
			controller,
			emit: (op) => expect(pen.emit(op), "the gesture was applied").toBe(true),
			down: (h) => void (held = h),
			undo: () => pen.historyStep(false),
			redo: () => pen.historyStep(true),
		};
	}
	return { store, pdfStore, plugin, passes, resolutions, openPlain, openPen };
}

/** The held pane's retry is due within the plugin's settle time (1 s): it runs once, and this waits for it to end. */
async function heldRetry(passes: Promise<void>[]): Promise<void> {
	const before = passes.length;
	await vi.advanceTimersByTimeAsync(1000);
	expect(passes.length, "the held pane's retry ran once").toBe(before + 1);
	await passes[passes.length - 1];
}

/** Gestures the second pane commits before the change, on its own id. */
const draw = (path: string, ...strokes: InkStroke[]): InkOp => ({ type: "add", path, strokes });
const erase = (path: string, all: readonly InkStroke[], cut: InkStroke, pieces: InkStroke[]): InkOp => {
	const at = all.findIndex((s) => s.id === cut.id);
	return { type: "replace", path, removed: [cut], removedAt: [at], inserted: pieces, insertedAt: pieces.map((_, i) => at + i) };
};
const move = (path: string, s: InkStroke, dx: number): InkOp =>
	({ type: "move", path, strokeIds: [s.id], dx, dy: 0, from: [{ x: s.points[0]!.x, y: s.points[0]!.y }] });

interface Road {
	name: string;
	/** What the second pane does before the change, on its own id `was`. */
	before(pen: Pen, s: ReturnType<typeof session>, was: string): void;
	/** The step pressed after the other pane carried: undo or redo. */
	step: "undo" | "redo";
	/** What the old file shows once the step is made. */
	stepped: string[];
	/** What it showed before the press. */
	unchanged: string[];
}

const X = stroke("whole", 10);
const P1 = stroke("piece-1", 40);
const P2 = stroke("piece-2", 70);
const K = stroke("kept", 100);

const roads: Road[] = [
	{
		name: "an erase undone puts the whole stroke back without its pieces, or nothing changes",
		before: (pen, s, was) => {
			pen.emit(draw(was, X));
			pen.emit(erase(was, s.pdfStore.strokes(was), X, [P1, P2]));
		},
		step: "undo", stepped: shape([X]), unchanged: shape([P1, P2]),
	},
	{
		name: "an add undone takes the stroke out of the new file too, or nothing changes",
		before: (pen, _s, was) => pen.emit(draw(was, X)),
		step: "undo", stepped: [], unchanged: shape([X]),
	},
	{
		name: "a move undone puts the stroke back where it was in the new file too, or nothing changes",
		before: (pen, s, was) => {
			pen.emit(draw(was, X));
			pen.emit(move(was, s.pdfStore.strokes(was)[0]!, 30));
		},
		step: "undo", stepped: shape([X]), unchanged: shape([stroke("whole", 40)]),
	},
	{
		name: "an erase redone leaves the pieces without the whole stroke, or nothing changes",
		before: (pen, s, was) => {
			pen.emit(draw(was, X));
			pen.emit(erase(was, s.pdfStore.strokes(was), X, [P1, P2]));
			expect(pen.undo(), "precondition: undone before the change").toBe(true);
		},
		step: "redo", stepped: shape([P1, P2]), unchanged: shape([X]),
	},
	{
		name: "an add redone puts the stroke in the new file too, or nothing changes",
		before: (pen, _s, was) => {
			pen.emit(draw(was, K));
			pen.emit(draw(was, X));
			expect(pen.undo(), "precondition: undone before the change").toBe(true);
		},
		step: "redo", stepped: shape([K, X]), unchanged: shape([K]),
	},
	{
		name: "a move redone moves the stroke in the new file too, or nothing changes",
		before: (pen, s, was) => {
			pen.emit(draw(was, X));
			pen.emit(move(was, s.pdfStore.strokes(was)[0]!, 30));
			expect(pen.undo(), "precondition: undone before the change").toBe(true);
		},
		step: "redo", stepped: shape([stroke("whole", 40)]), unchanged: shape([X]),
	},
	{
		name: "a lasso delete undone puts the strokes back in the new file too, or nothing changes",
		before: (pen, s, was) => {
			pen.emit(draw(was, K));
			pen.emit(draw(was, X));
			const all = s.pdfStore.strokes(was);
			pen.emit({ type: "remove", path: was, strokes: [all[1]!], indices: [1] });
		},
		step: "undo", stepped: shape([K, X]), unchanged: shape([K]),
	},
];

/**
 * The second pane's step after the other pane carried, and the one check every cell makes: the press made the step or
 * left the ink as it was, the new file ends holding what the pane showed right after the press, and never a stroke with
 * its erased pieces.
 */
function settles(road: Road, pressed: string[], now: readonly InkStroke[]) {
	expect([road.stepped, road.unchanged], "the press made the step, or left the ink as it was").toContainEqual(pressed);
	const held = now.map((s) => s.id);
	expect(held.includes(X.id) && (held.includes(P1.id) || held.includes(P2.id)), `a stroke and its erased pieces in the new file: ${held}`).toBe(false);
	expect(shape(now), "the new file holds what the pane showed after the press").toEqual(pressed);
}

for (const road of roads) {
	for (const late of [0, 50]) {
		if (late && road !== roads[0]) continue;
		const digestNote = late ? ` (the digest lands ${late} ms late)` : "";
		it(`busy pane on a changed PDF, after the other pane carried: ${road.name}${digestNote}`, async () => {
			if (late) lateDigest(late);
			const v = vault();
			const s = session(v);
			const first = await s.openPlain();
			const pen = await s.openPen();
			const was = s.plugin.pdfIds.get(pen.root) as string;
			expect(s.plugin.pdfIds.get(first.root), "both panes show the same ink").toBe(was);
			road.before(pen, s, was);
			await s.store.flush();
			expect(shape(s.pdfStore.strokes(was)), "precondition: the old file before the change").toEqual(road.unchanged);
			pen.down(true);
			mutate(v);
			await s.plugin.onPdfModified("Paper.pdf");
			const now = s.plugin.pdfIds.get(first.root) as string;
			expect(now, "the idle pane moved to the new ink file").not.toBe(was);
			expect(s.plugin.pdfIds.get(pen.root), "the busy pane is left on the old one").toBe(was);
			expect(shape(s.pdfStore.strokes(now)), "precondition: carried by the idle pane").toEqual(road.unchanged);
			pen.down(false);
			if (road.step === "undo") pen.undo();
			else pen.redo();
			const pressed = shape(s.pdfStore.strokes(was));
			await heldRetry(s.passes);
			expect(s.plugin.pdfIds.get(pen.root), "the busy pane moved once it went idle").toBe(now);
			settles(road, pressed, s.pdfStore.strokes(now));
		});
	}
}

/**
 * The other pane is painted from the new file once the busy pane's step lands there. A late carry that only takes a
 * stroke out or swaps one, and adds none, must still repaint it, or it goes on showing ink the file no longer holds.
 */
for (const road of roads) {
	it(`busy pane on a changed PDF, after the other pane carried, the other pane paints what the new file holds: ${road.name}`, async () => {
		const v = vault();
		const s = session(v);
		const first = await s.openPlain();
		let painted: string[] | null = null;
		first.controller.refresh = () => {
			const id = s.plugin.pdfIds.get(first.root) as string | undefined;
			painted = id === undefined ? null : shape(s.pdfStore.strokes(id));
		};
		const pen = await s.openPen();
		const was = s.plugin.pdfIds.get(pen.root) as string;
		road.before(pen, s, was);
		await s.store.flush();
		pen.down(true);
		mutate(v);
		await s.plugin.onPdfModified("Paper.pdf");
		const now = s.plugin.pdfIds.get(first.root) as string;
		expect(now, "the idle pane moved to the new ink file").not.toBe(was);
		expect(painted, "precondition: the idle pane was painted with the carried ink").toEqual(road.unchanged);
		pen.down(false);
		if (road.step === "undo") pen.undo();
		else pen.redo();
		const pressed = shape(s.pdfStore.strokes(was));
		await heldRetry(s.passes);
		expect(s.plugin.pdfIds.get(pen.root), "the busy pane moved once it went idle").toBe(now);
		settles(road, pressed, s.pdfStore.strokes(now));
		expect(painted, "the other pane paints what the new file holds").toEqual(shape(s.pdfStore.strokes(now)));
	});
}

/**
 * The PDF changes twice. The busy pane is held across the first change while the idle pane carries the old file into
 * the middle one; it then goes idle and makes its step on the old file. The second change lands before its retry, so
 * one check identifies both panes (a wait for every pane takes over the wait for one): the idle pane carries the middle
 * file on and the busy pane carries the old file, into the same newest file. In either order the newest file ends
 * holding what the busy pane showed after the press.
 */
for (const order of ["the idle pane", "the busy pane"] as const) {
	for (const road of roads) {
		it(`busy pane on a PDF that changes twice, ${order} carried first into the newest file: ${road.name}`, async () => {
			const v = vault();
			const s = session(v);
			const [first, pen] = order === "the idle pane"
				? ([await s.openPlain(), await s.openPen()] as const)
				: await (async () => {
					const p = await s.openPen();
					return [await s.openPlain(), p] as const;
				})();
			const was = s.plugin.pdfIds.get(pen.root) as string;
			expect(s.plugin.pdfIds.get(first.root), "both panes show the same ink").toBe(was);
			road.before(pen, s, was);
			await s.store.flush();
			pen.down(true);
			mutate(v);
			await s.plugin.onPdfModified("Paper.pdf");
			const middle = s.plugin.pdfIds.get(first.root) as string;
			expect(middle, "precondition: the idle pane moved to the middle file").not.toBe(was);
			expect(s.plugin.pdfIds.get(pen.root), "precondition: the busy pane is left on the old one").toBe(was);
			expect(shape(s.pdfStore.strokes(middle)), "precondition: carried by the idle pane").toEqual(road.unchanged);
			pen.down(false);
			if (road.step === "undo") pen.undo();
			else pen.redo();
			const pressed = shape(s.pdfStore.strokes(was));
			mutate(v, 101);
			const before = s.passes.length;
			s.plugin.schedulePdfModified("Paper.pdf");
			await vi.advanceTimersByTimeAsync(1000);
			expect(s.passes.length, "one check, for both panes").toBe(before + 1);
			await s.passes[s.passes.length - 1];
			const now = s.plugin.pdfIds.get(first.root) as string;
			expect(now, "precondition: the idle pane moved to the newest file").not.toBe(middle);
			expect(now, "precondition: the newest file is not the old one").not.toBe(was);
			expect(s.plugin.pdfIds.get(pen.root), "the busy pane is on the newest file too").toBe(now);
			settles(road, pressed, s.pdfStore.strokes(now));
		});
	}
}

/**
 * A stroke that came through an earlier change. The PDF changes once with both panes idle, and both carry the stroke
 * into the middle file. The second pane edits it there and undoes the edit, then is busy when the PDF changes again
 * and the idle pane carries the middle file on; it goes idle and redoes the edit on the middle file. The newest file
 * ends holding what the pane showed after the press.
 */
const redoneAfterAnEarlierCarry: Road[] = [
	{
		name: "an erase redone on the middle file leaves the pieces without the whole stroke, or nothing changes",
		before: (pen, s, was) => {
			pen.emit(erase(was, s.pdfStore.strokes(was), s.pdfStore.strokes(was)[0]!, [P1, P2]));
			expect(pen.undo(), "precondition: undone before the change").toBe(true);
		},
		step: "redo", stepped: shape([P1, P2]), unchanged: shape([X]),
	},
	{
		name: "a lasso delete redone on the middle file takes the stroke out of the newest file too, or nothing changes",
		before: (pen, s, was) => {
			const all = s.pdfStore.strokes(was);
			const at = all.findIndex((st) => st.id === X.id);
			pen.emit({ type: "remove", path: was, strokes: [all[at]!], indices: [at] });
			expect(pen.undo(), "precondition: undone before the change").toBe(true);
		},
		step: "redo", stepped: shape([K]), unchanged: shape([K, X]),
	},
];

for (const road of redoneAfterAnEarlierCarry) {
	it(`busy pane on a PDF that changed before, with every pane idle: ${road.name}`, async () => {
		const v = vault();
		const s = session(v);
		const first = await s.openPlain();
		const pen = await s.openPen();
		const oldest = s.plugin.pdfIds.get(pen.root) as string;
		if (road === redoneAfterAnEarlierCarry[1]) pen.emit(draw(oldest, K));
		pen.emit(draw(oldest, X));
		await s.store.flush();
		mutate(v);
		await s.plugin.onPdfModified("Paper.pdf");
		const was = s.plugin.pdfIds.get(pen.root) as string;
		expect(was, "precondition: the first change moved the pane to the middle file").not.toBe(oldest);
		expect(s.plugin.pdfIds.get(first.root), "precondition: both panes on the middle file").toBe(was);
		expect(shape(s.pdfStore.strokes(was)), "precondition: the middle file holds the carried ink").toEqual(road.unchanged);
		road.before(pen, s, was);
		await s.store.flush();
		expect(shape(s.pdfStore.strokes(was)), "precondition: the middle file before the second change").toEqual(road.unchanged);
		pen.down(true);
		mutate(v, 101);
		await s.plugin.onPdfModified("Paper.pdf");
		const now = s.plugin.pdfIds.get(first.root) as string;
		expect(now, "the idle pane moved to the newest file").not.toBe(was);
		expect(s.plugin.pdfIds.get(pen.root), "the busy pane is left on the middle file").toBe(was);
		expect(shape(s.pdfStore.strokes(now)), "precondition: carried by the idle pane").toEqual(road.unchanged);
		pen.down(false);
		pen.redo();
		const pressed = shape(s.pdfStore.strokes(was));
		await heldRetry(s.passes);
		expect(s.plugin.pdfIds.get(pen.root), "the busy pane moved once it went idle").toBe(now);
		settles(road, pressed, s.pdfStore.strokes(now));
	});
}

it("busy pane on a changed PDF: an erase undone while the other pane's carry is still being made puts the whole stroke back without its pieces, or nothing changes", async () => {
	const road = roads[0]!;
	const v = vault();
	const s = session(v);
	const first = await s.openPlain();
	const pen = await s.openPen();
	const was = s.plugin.pdfIds.get(pen.root) as string;
	road.before(pen, s, was);
	await s.store.flush();
	pen.down(true);
	mutate(v);
	// The check takes the old file's ink for the idle pane now and carries it once the new id lands; the press comes
	// between the two.
	const check = s.plugin.onPdfModified("Paper.pdf");
	expect(s.plugin.pdfIds.get(pen.root), "the busy pane is left on the old file").toBe(was);
	pen.down(false);
	pen.undo();
	const pressed = shape(s.pdfStore.strokes(was));
	await check;
	const now = s.plugin.pdfIds.get(first.root) as string;
	expect(now, "the idle pane moved to the new ink file").not.toBe(was);
	await heldRetry(s.passes);
	expect(s.plugin.pdfIds.get(pen.root)).toBe(now);
	settles(road, pressed, s.pdfStore.strokes(now));
});

it("a lone pane busy during the change, with no carry made, undoes an erase as today and the new file gets the undone ink", async () => {
	const v = vault();
	const s = session(v);
	const pen = await s.openPen();
	const was = s.plugin.pdfIds.get(pen.root) as string;
	roads[0]!.before(pen, s, was);
	await s.store.flush();
	pen.down(true);
	mutate(v);
	await s.plugin.onPdfModified("Paper.pdf");
	expect(s.plugin.pdfIds.get(pen.root), "held: no pane identified, nothing carried").toBe(was);
	pen.down(false);
	expect(pen.undo(), "the undo is made").toBe(true);
	expect(shape(s.pdfStore.strokes(was)), "and shows at once").toEqual(shape([X]));
	await heldRetry(s.passes);
	const now = s.plugin.pdfIds.get(pen.root) as string;
	expect(now).not.toBe(was);
	expect(shape(s.pdfStore.strokes(now)), "the new file holds the undone ink").toEqual(shape([X]));
});

/**
 * The busy pane is left on the old file while the other carries, then identified again: by its own retry, or by a switch
 * to another PDF. The bytes then go back to the old version, which has its own ink file, and the pane is on that file
 * once more. A stroke drawn there now is undone as today.
 */
for (const away of ["its retry", "a switch to another PDF and back"] as const) {
	it(`a busy pane identified again by ${away}, then back on the old version's file, undoes a new stroke as today`, async () => {
		const v = vault();
		v.pdfs.set("Other.pdf", new TextEncoder().encode("%PDF-1.4\n" + "o".repeat(3000) + "\n%%EOF\n"));
		const original = v.pdfs.get("Paper.pdf")!;
		const s = session(v);
		const first = await s.openPlain();
		const pen = await s.openPen();
		const was = s.plugin.pdfIds.get(pen.root) as string;
		pen.emit(draw(was, X));
		await s.store.flush();
		pen.down(true);
		mutate(v);
		await s.plugin.onPdfModified("Paper.pdf");
		const now = s.plugin.pdfIds.get(first.root) as string;
		expect(now, "precondition: the idle pane carried").not.toBe(was);
		pen.down(false);
		const leaf = s.plugin.app.workspace.getLeavesOfType("pdf").find((l: { view: { containerEl: HTMLElement } }) => l.view.containerEl === pen.root);
		const identified = async () => {
			const before = s.resolutions.length;
			s.plugin.syncPdfControllers();
			expect(s.resolutions.length, "the switch identified the pane").toBe(before + 1);
			await s.resolutions[s.resolutions.length - 1];
		};
		if (away === "its retry") {
			await heldRetry(s.passes);
			expect(s.plugin.pdfIds.get(pen.root)).toBe(now);
		} else {
			leaf.view.file = { path: "Other.pdf" };
			await identified();
			expect(s.plugin.pdfIds.get(pen.root), "on the other PDF").not.toBe(was);
		}
		await s.store.flush();
		v.pdfs.set("Paper.pdf", original);
		if (away === "its retry") {
			await s.plugin.onPdfModified("Paper.pdf");
		} else {
			await s.plugin.onPdfModified("Paper.pdf");
			leaf.view.file = { path: "Paper.pdf" };
			await identified();
		}
		expect(s.plugin.pdfIds.get(pen.root), "the old bytes find their own ink file").toBe(was);
		const before = shape(s.pdfStore.strokes(was));
		pen.emit(draw(was, K));
		expect(pen.undo(), "the undo is made").toBe(true);
		expect(shape(s.pdfStore.strokes(was)), "the new stroke is gone").toEqual(before);
	});
}

it("two panes both busy during the change, with no carry made, undo an erase as today and the new file gets the undone ink", async () => {
	const v = vault();
	const s = session(v);
	const first = await s.openPlain();
	const pen = await s.openPen();
	const was = s.plugin.pdfIds.get(pen.root) as string;
	roads[0]!.before(pen, s, was);
	await s.store.flush();
	first.controller.idle = false;
	pen.down(true);
	mutate(v);
	await s.plugin.onPdfModified("Paper.pdf");
	expect(s.plugin.pdfIds.get(first.root), "held").toBe(was);
	expect(s.plugin.pdfIds.get(pen.root), "held").toBe(was);
	first.controller.idle = true;
	pen.down(false);
	expect(pen.undo(), "the undo is made").toBe(true);
	expect(shape(s.pdfStore.strokes(was)), "and shows at once").toEqual(shape([X]));
	await heldRetry(s.passes);
	const now = s.plugin.pdfIds.get(pen.root) as string;
	expect(now).not.toBe(was);
	expect(s.plugin.pdfIds.get(first.root)).toBe(now);
	expect(shape(s.pdfStore.strokes(now)), "the new file holds the undone ink").toEqual(shape([X]));
});
