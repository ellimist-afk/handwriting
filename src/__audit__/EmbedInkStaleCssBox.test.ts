import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachEmbedInk, disarmPrintSwaps, embedInkChanged, embedInkScale, initEmbedInkRefresh, teardownEmbedInk } from "../inline/EmbedInk";
import { InkStroke } from "../ink/Stroke";

/**
 * An embed ink canvas whose box grows past the pixel budget.
 *
 * Claim: EmbedInk.ts paint writes the canvas css size only inside the guard that fires when the
 * BACKING size changed. A note whose ink box is over the 4M pixel budget gets a backing store
 * scaled down to the budget; when one more stroke grows the box by (nearly) the same ratio both
 * ways, the rounded backing size is unchanged, the guard skips the css write, and the canvas
 * keeps the old css box while the ink is drawn for the new one: shrunk toward the top-left.
 *
 * The cells assert the CORRECT behaviour, so they go red only if the bug is real. The rig is the
 * fake element tree of EmbedPrintRefresh.test.ts at a device pixel ratio of 2; the code under
 * test is the real attachEmbedInk and embedInkChanged.
 */

/** A stroke whose box is exactly w by h from the origin. */
function box(id: string, w: number, h: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: w, y: h, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: w, height: h },
		createdAt: 0,
	} as InkStroke;
}

class FEl {
	readonly attrs = new Map<string, string>();
	readonly children: FEl[] = [];
	readonly style: Record<string, string> & { removeProperty(p: string): void } = Object.assign({} as Record<string, string>, {
		removeProperty(p: string): void {
			delete (this as unknown as Record<string, string>)[p];
		},
	});
	parentElement: FEl | null = null;
	width = 0;
	height = 0;
	isConnected = true;
	constructor(readonly tag: string, readonly ownerDocument: FDoc) {}
	get firstChild(): FEl | null {
		return this.children[0] ?? null;
	}
	get classList() {
		return { contains: (c: string) => (this.attrs.get("class") ?? "").split(" ").includes(c) };
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	appendChild(c: FEl): FEl {
		c.parentElement?.removeChild(c);
		this.children.push(c);
		c.parentElement = this;
		return c;
	}
	removeChild(c: FEl): FEl {
		const i = this.children.indexOf(c);
		if (i >= 0) this.children.splice(i, 1);
		c.parentElement = null;
		return c;
	}
	remove(): void {
		this.parentElement?.removeChild(this);
	}
	querySelector(sel: string): FEl | null {
		const m = /^:scope > ([a-z]+)\.([a-zA-Z0-9_-]+)$/.exec(sel);
		if (!m) return null;
		return this.children.find((k) => k.tag === m[1] && (k.attrs.get("class") ?? "").split(" ").includes(m[2]!)) ?? null;
	}
	createEl(tag: string, opts: { cls?: string } = {}): FEl {
		const el = new FEl(tag, this.ownerDocument);
		if (opts.cls) el.attrs.set("class", opts.cls);
		return this.appendChild(el);
	}
	setCssStyles(s: Record<string, string>): void {
		Object.assign(this.style, s);
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 300, height: 300 };
	}
	getContext() {
		return new Proxy({} as Record<string, unknown>, {
			get: (t, k) => (k in t ? t[k as string] : () => {}),
			set: (t, k, v) => ((t[k as string] = v), true),
		});
	}
	closest(): null {
		return null;
	}
}

class FDoc {
	readonly listeners = new Map<string, Array<() => void>>();
	readonly mqFns: Array<(e: { matches: boolean }) => void> = [];
	readonly mq = {
		matches: false,
		addEventListener: (_t: string, fn: (e: { matches: boolean }) => void): void => {
			this.mqFns.push(fn);
		},
		removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void): void => {
			this.mqFns.splice(0, this.mqFns.length, ...this.mqFns.filter((f) => f !== fn));
		},
	};
	/** The print media query changes, as it does on a print path that never dispatches beforeprint. */
	media(matches: boolean): void {
		for (const fn of [...this.mqFns]) fn({ matches });
	}
	readonly defaultView = {
		devicePixelRatio: 2,
		getComputedStyle: () => ({ position: "relative" }),
		addEventListener: (type: string, fn: () => void): void => {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
		},
		removeEventListener: (type: string, fn: () => void): void => {
			this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
		},
		matchMedia: () => this.mq,
		setTimeout: (): number => 0,
		clearTimeout: (): void => {},
	};
	createElementNS(_ns: string, tag: string): FEl {
		return new FEl(tag, this);
	}
	fire(type: string): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
	}
}

let current: InkStroke[];

beforeEach(() => {
	current = [];
	initEmbedInkRefresh(() => current);
});
afterEach(() => {
	disarmPrintSwaps();
	teardownEmbedInk();
});

function layer(root: FEl): FEl {
	const canvas = root.querySelector(":scope > canvas.handwriting-embed-ink");
	if (!canvas) throw new Error("no ink canvas on the root");
	return canvas;
}

/** Attach with the first box, then repaint with the second, as a saved stroke does. */
function grow(from: [number, number], to: [number, number]): { root: FEl; before: { w: number; h: number; css: string[] } } {
	const doc = new FDoc();
	const root = new FEl("div", doc);
	current = [box("s1", from[0], from[1])];
	attachEmbedInk(root as unknown as HTMLElement, "a.md", current);
	const c = layer(root);
	const before = { w: c.width, h: c.height, css: [c.style.width as string, c.style.height as string] };
	current = [box("s1", from[0], from[1]), box("s2", to[0], to[1])];
	embedInkChanged("a.md");
	return { root, before };
}

describe("embed ink canvas css box after the ink box grows", () => {
	it("precondition: 1000x2000 and 1100x2200 at dpr 2 are over the budget and share one rounded backing size", () => {
		const s1 = embedInkScale(1000, 2000, 2);
		const s2 = embedInkScale(1100, 2200, 2);
		expect(1000 * 2000 * 4, "over the 4M pixel budget at dpr 2").toBeGreaterThan(4_000_000);
		expect([Math.round(1000 * s1), Math.round(2000 * s1)]).toEqual([Math.round(1100 * s2), Math.round(2200 * s2)]);
	});

	it("control: the first paint sets the css box to the ink box", () => {
		const { before } = grow([1000, 2000], [1000, 2000]);
		expect(before.css).toEqual(["1000px", "2000px"]);
	});

	it("(red when the bug is real) a box grown by the same ratio both ways gets the new css box", () => {
		const { root, before } = grow([1000, 2000], [1100, 2200]);
		const c = layer(root);
		expect({ w: c.width, h: c.height }, "premise: the backing store did not change").toEqual({ w: before.w, h: before.h });
		expect([c.style.width, c.style.height], "the css box follows the ink box").toEqual(["1100px", "2200px"]);
	});

	it("control: a box grown by a different ratio gets the new css box", () => {
		const { root } = grow([1000, 2000], [1100, 2600]);
		const c = layer(root);
		expect([c.style.width, c.style.height]).toEqual(["1100px", "2600px"]);
	});

	it("control: a box under the budget grows and its css box follows", () => {
		const { root } = grow([300, 400], [330, 440]);
		const c = layer(root);
		expect([c.style.width, c.style.height]).toEqual(["330px", "440px"]);
	});
});
