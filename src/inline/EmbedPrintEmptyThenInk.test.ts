import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachEmbedInk, disarmPrintSwaps, embedInkChanged, initEmbedInkRefresh, teardownEmbedInk } from "./EmbedInk";
import { InkStroke } from "../ink/Stroke";

/**
 * A print is running, the note's last stroke goes, and strokes come back
 * before the print ends. The vector layer is the picture the export captures,
 * so it has to come back with them.
 *
 * The fake elements and document are the ones EmbedPrintRefresh.test.ts
 * builds, copied here so this file stands alone.
 */

function stroke(id: string, x1: number, y1: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: x1, y: y1, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: x1, height: y1 },
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
		devicePixelRatio: 1,
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

describe("a print in progress, ink that goes empty, and ink that comes back", () => {
	it("the vector layer an export captures returns when strokes return during the same print", () => {
		const doc = new FDoc();
		const root = new FEl("div", doc);
		current = [stroke("s1", 10, 10)];
		attachEmbedInk(root as unknown as HTMLElement, "a.md", current);
		doc.fire("beforeprint");
		expect(root.querySelector(":scope > svg.handwriting-embed-ink"), "premise: the print swap built a vector layer").not.toBeNull();

		// The last stroke is erased while the print runs: the vector layer goes with it.
		current = [];
		embedInkChanged("a.md");
		expect(root.querySelector(":scope > svg.handwriting-embed-ink"), "premise: no strokes, no vector layer").toBeNull();

		// A stroke is drawn again before the print ends.
		current = [stroke("s2", 200, 40)];
		embedInkChanged("a.md");

		const after = root.querySelector(":scope > svg.handwriting-embed-ink");
		expect(after, "the print has no vector layer for the new stroke").not.toBeNull();
		expect(after?.getAttribute("viewBox"), "the vector layer holds the new stroke").toBe("0 0 200 40");
	});
});
