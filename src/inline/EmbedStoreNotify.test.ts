import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachEmbedInk, embedInkChanged, initEmbedInkRefresh, teardownEmbedInk } from "./EmbedInk";
import { onInkChanged } from "./InkEvents";
import { InlineInkStore } from "./InlineInkStore";
import { InkStroke } from "../ink/Stroke";
import { emptyPage, PageData } from "../model/PageData";

function stroke(id: string, h: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: h, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: h },
		createdAt: 0,
	} as InkStroke;
}

function page(id: string, ...strokes: InkStroke[]): PageData {
	const p = emptyPage(id);
	(p as PageData & { surface: string }).surface = "inline";
	p.strokes = strokes;
	return p;
}

/** An embed content box already laid out, recording what it last drew. */
function embedRoot() {
	const attrs = new Map<string, string>();
	const style = { position: "relative", minHeight: "", removeProperty(k: string): void {
		if (k === "min-height") style.minHeight = "";
	} };
	let canvas: unknown = null;
	const root = {
		style,
		isConnected: true,
		parentElement: null,
		classList: { contains: (c: string) => c === "markdown-embed-content" },
		setCssStyles(s: Record<string, string>): void {
			if ("minHeight" in s) style.minHeight = s.minHeight ?? "";
		},
		getBoundingClientRect: () => ({ width: 300, height: 300 }),
		querySelector: (sel: string) => (sel.includes("canvas") ? canvas : null),
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		createEl: () => {
			canvas = {
				style: {} as Record<string, string>,
				width: 0,
				height: 0,
				setCssStyles(this: { style: Record<string, string> }, s: Record<string, string>) {
					Object.assign(this.style, s);
				},
				// Any 2D call is a no-op; property writes (globalAlpha, fillStyle...) are kept.
				getContext: () =>
					new Proxy({} as Record<string, unknown>, {
						get: (t, k) => (k in t ? t[k as string] : () => {}),
						set: (t, k, v) => ((t[k as string] = v), true),
					}),
				remove: () => void (canvas = null),
			};
			return canvas;
		},
		get hasInk(): boolean {
			return canvas !== null;
		},
		ownerDocument: {
			defaultView: {
				addEventListener() {},
				removeEventListener() {},
				getComputedStyle: () => ({ position: "relative" }),
				devicePixelRatio: 1,
			},
		},
	};
	return root;
}

let store: InlineInkStore;
let ids: Map<string, string>;
let disk: Map<string, PageData>;
let changedOnDisk: Set<string>;
let damagedOnDisk: Set<string>;
let unsubscribe: () => void;

beforeEach(() => {
	ids = new Map();
	disk = new Map();
	changedOnDisk = new Set();
	damagedOnDisk = new Set();
	store = new InlineInkStore();
	store.attachHost({
		readPageId: (p: string) => ids.get(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: async (id: string) => {
			if (damagedOnDisk.has(id)) return { data: page(id), recovered: false, damaged: true };
			const d = disk.get(id);
			return d ? { data: d, recovered: false } : null;
		},
		scheduleSidecar: () => {},
		sidecarChanged: async (id: string) => changedOnDisk.has(id),
		prepareExternalAdoption: async (id: string) => ({
			kind: "prepared",
			prepared: { pageId: id, data: disk.get(id)!, reused: false, mtime: 2, stamp: "b" },
		}),
		acceptExternalAdoption: (prep: { pageId: string }) => void changedOnDisk.delete(prep.pageId),
		notify: () => {},
	} as never);
	// Exactly the plugin's wiring (main.ts: initEmbedInkRefresh + onInkChanged -> embedInkChanged).
	initEmbedInkRefresh((p) => store.strokes(p));
	unsubscribe = onInkChanged((p) => embedInkChanged(p));
});

afterEach(() => {
	unsubscribe();
	teardownEmbedInk();
});

async function loadedWithInk(path: string, id: string, ...strokes: InkStroke[]) {
	ids.set(path, id);
	disk.set(id, page(id, ...strokes));
	await store.ensureLoaded(path);
	const root = embedRoot();
	attachEmbedInk(root as unknown as HTMLElement, path, store.strokes(path));
	expect(root.hasInk).toBe(true);
	return root;
}

describe("embeds follow store changes that are not gestures", () => {
	it("second device: reopening the note adopts newer ink, and the embed of it follows", async () => {
		const root = await loadedWithInk("a.md", "pid-a", stroke("s1", 40));
		expect(root.style.minHeight).toBe("40px");

		// Device 2 adds a long stroke while a.md has no open editor; a.md is reopened.
		disk.set("pid-a", page("pid-a", stroke("s1", 40), stroke("s2", 500)));
		changedOnDisk.add("pid-a");
		expect(await store.ensureLoaded("a.md")).toBe(true); // editor repaints from this
		expect(store.strokes("a.md")).toHaveLength(2);

		// The embed of a.md elsewhere still shows the 40px picture.
		expect(root.style.minHeight).toBe("500px");
	});

	it("note deleted: an embed of it does not keep the dead note's ink", async () => {
		const root = await loadedWithInk("gone.md", "pid-gone", stroke("s1", 120));
		store.handleDelete("gone.md"); // main.ts vault 'delete'
		expect(store.strokes("gone.md")).toHaveLength(0);
		expect(root.hasInk).toBe(false);
	});

	it("id line removed from a duplicate copy: its embed stops showing the original's ink", async () => {
		const root = await loadedWithInk("copy.md", "pid-shared", stroke("s1", 120));
		ids.delete("copy.md"); // the user follows the duplicate notice
		store.handleDeclaimed("copy.md"); // main.ts declaimNow
		expect(store.strokes("copy.md")).toHaveLength(0);
		expect(root.hasInk).toBe(false);
	});

	it("id line removed from a duplicate copy that carries its own ink: its embed shows only that ink", async () => {
		const root = await loadedWithInk("copy2.md", "pid-shared2", stroke("s1", 120));
		store.commit("copy2.md", stroke("mine", 77)); // drawn on the copy before it was found to share an id
		store.markDuplicateLocked("copy2.md", "original2.md");
		expect(root.style.minHeight).toBe("120px");
		ids.delete("copy2.md");
		store.handleDeclaimed("copy2.md");
		expect(store.strokes("copy2.md").map((s) => s.id)).toEqual(["mine"]);
		expect(root.hasInk).toBe(true);
		expect(root.style.minHeight, "the embed follows the carried ink, not the shared page").toBe("77px");
	});

	it("a damaged ink file repaired by sync: reopening the note restores it, and the embed of it follows", async () => {
		ids.set("fix.md", "pid-fix");
		damagedOnDisk.add("pid-fix");
		await store.ensureLoaded("fix.md");
		expect(store.strokes("fix.md")).toHaveLength(0);
		const root = embedRoot();
		attachEmbedInk(root as unknown as HTMLElement, "fix.md", store.strokes("fix.md"));
		expect(root.hasInk, "premise: nothing to draw while the file is damaged").toBe(false);

		// Another device's copy repairs the file; the note is reopened.
		damagedOnDisk.delete("pid-fix");
		disk.set("pid-fix", page("pid-fix", stroke("s1", 500)));
		expect(await store.ensureLoaded("fix.md")).toBe(true); // editor repaints from this
		expect(store.strokes("fix.md")).toHaveLength(1);

		expect(root.hasInk).toBe(true);
		expect(root.style.minHeight).toBe("500px");
	});
});
