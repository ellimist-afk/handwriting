/**
 * The unload notice speaks only for ink that is waiting.
 *
 * `finishPersistence` tells the user "the newest ink may not have been saved" when a settle gives up at its deadline.
 * A settle gives up whenever any read is still in flight at the deadline, also when nothing was drawn behind that read,
 * so a slow sidecar read at quit raised the notice with no ink at risk. A false alarm teaches the user to ignore the
 * notice that matters.
 *
 * Real `finishPersistence`, the real inline ink store (the registry's) and a real PDF store, each over a host whose
 * sidecar read never finishes. Substituted: the slides settle (finishes), the settings flush, and `Notice`, which
 * records. The page store is real, over a `FakeAdapter`, with nothing queued.
 *
 *   - a read in flight past the deadline with no stroke behind it: no notice (inline, and PDF);
 *   - control: a stroke drawn behind that read: the notice, once (inline, and PDF).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signals = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			signals.notices.push(message);
		}
	},
}));
vi.mock("./slides/SlidesInkSurface", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	settleSlidesInk: vi.fn(async () => true),
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { computeBBox, type InkStroke } from "./ink/Stroke";
import { inlineInk } from "./inline/InkOverlayRegistry";
import { PdfInkStore } from "./pdf/PdfInkStore";

function stroke(id: string): InkStroke {
	const points = [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.6, t: 4 }];
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 7, points, bbox: computeBBox(points, 4), page: 1 };
}

/** Every read the hosts started; each finishes (with no file) only when the case is over. */
const hung: Array<() => void> = [];
function never<T>(): Promise<T | null> {
	return new Promise<T | null>((resolve) => hung.push(() => resolve(null)));
}

let n = 0;
function device() {
	n++;
	const notePath = `slow-${n}.md`, notePage = `slow-note-${n}`, pdfId = `slow-pdf-${n}`;
	const store = new PageStore({ vault: { adapter: new FakeAdapter() } } as never);
	inlineInk.attachHost({
		readPageId: (p: string) => (p === notePath ? notePage : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: () => never(),
		scheduleSidecar: () => {},
		notify: () => {},
	});
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({ load: () => never(), schedule: () => {}, notice: () => {} });
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & { finishPersistence(): Promise<void> };
	Object.assign(plugin, { store, pdfStore, flushSettings: async () => {} });
	return { plugin, pdfStore, notePath, pdfId };
}

async function quit(plugin: { finishPersistence(): Promise<void> }): Promise<void> {
	const done = plugin.finishPersistence();
	// Past both 2000 ms deadlines, inline and PDF, which run one after the other.
	await vi.advanceTimersByTimeAsync(6000);
	await done;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.spyOn(console, "error").mockImplementation(() => {});
	signals.notices.length = 0;
});
afterEach(async () => {
	// Let every read finish, so nothing a case left waiting is seen by the next one.
	for (const finish of hung.splice(0)) finish();
	await vi.advanceTimersByTimeAsync(100);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the unload notice when a sidecar read is still in flight at quit", () => {
	it("a note's read is still in flight and nothing was drawn behind it: no notice", async () => {
		const d = device();
		void inlineInk.ensureLoaded(d.notePath);
		expect(inlineInk.record(d.notePath).loadInFlight, "premise: the note's read is in flight").not.toBeNull();

		await quit(d.plugin);

		expect(signals.notices, "no ink was waiting, so nothing may be said").toEqual([]);
	});

	it("a PDF's read is still in flight and nothing was drawn behind it: no notice", async () => {
		const d = device();
		void d.pdfStore.ensureLoaded(d.pdfId);
		expect((d.pdfStore as unknown as { byId: Map<string, { loadInFlight: unknown }> }).byId.get(d.pdfId)?.loadInFlight,
			"premise: the PDF's read is in flight").toBeTruthy();

		await quit(d.plugin);

		expect(signals.notices, "no ink was waiting, so nothing may be said").toEqual([]);
	});

	it("control: a stroke drawn on a note behind its read: the user is told, once", async () => {
		const d = device();
		void inlineInk.ensureLoaded(d.notePath);
		inlineInk.commit(d.notePath, stroke("behind-the-read"));

		await quit(d.plugin);

		expect(signals.notices.length, "a stroke waiting on a read that never landed is unsaved").toBe(1);
	});

	it("control: a stroke drawn on a PDF behind its read: the user is told, once", async () => {
		const d = device();
		void d.pdfStore.ensureLoaded(d.pdfId);
		d.pdfStore.commit(d.pdfId, stroke("behind-the-read"));

		await quit(d.plugin);

		expect(signals.notices.length, "a stroke waiting on a read that never landed is unsaved").toBe(1);
	});
});
