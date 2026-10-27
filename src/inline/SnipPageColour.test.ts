/**
 * A note snip paints its own white page and draws the ink on it, whatever theme the note was taken under. The page
 * colour is one constant that serves twice: it is the fill behind the ink and the destination the ink is made
 * readable against. The snip commands elsewhere stub snipSelection out, so nothing reached either use.
 *
 * Held through the real snipSelection on an unmounted overlay with a recording canvas: the rectangle is filled
 * white before any ink is drawn, and the palette's white pen, the colour the dark theme draws with, is drawn dark
 * enough to read on that white. A page of any other colour fails the first; a page the ink is not adapted to
 * fails the second.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { contrastRatio, EXPORT_MIN_CONTRAST, relativeLuminance } from "../ink/InkTheme";
import type { InkStroke } from "../ink/Stroke";
import { InkOverlayPlugin } from "./InkOverlay";

/** The palette's near-white pen: the colour the dark theme draws with and a white page would swallow. */
const PEN_WHITE = "#f4f4f2";
const PEN_BLACK = "#111111";

function stroke(id: string, color: string): InkStroke {
	return {
		id, tool: "pen", color, width: 4, createdAt: 1,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 60, y: 40, pressure: 0.5, t: 1 }],
		bbox: { x: 8, y: 8, width: 54, height: 34 },
	};
}

/** A 2d context that records every colour set on it, with the draw call it was set before. */
function recordingContext() {
	const log: { op: string; prop?: string; value?: unknown }[] = [];
	const target: Record<string, unknown> = {};
	const ctx = new Proxy(target, {
		get: (_t, prop: string) => {
			if (prop in target) return target[prop];
			return (..._args: unknown[]) => { log.push({ op: prop }); };
		},
		set: (_t, prop: string, value) => {
			target[prop] = value;
			if (prop === "fillStyle" || prop === "strokeStyle") log.push({ op: "set", prop, value });
			return true;
		},
	});
	return { ctx, log };
}

function hexOf(css: unknown): string {
	const s = String(css).trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(s)) return s;
	const m = s.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (!m) throw new Error(`unreadable colour ${s}`);
	return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

function lum(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	return relativeLuminance((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

async function snip(strokes: InkStroke[]) {
	const { ctx, log } = recordingContext();
	vi.stubGlobal("createEl", () => ({
		width: 0, height: 0,
		getContext: () => ctx,
		toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
	}));
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	overlay.selection = { isEmpty: false } as never;
	overlay.selectionBounds = () => ({ x: 8, y: 8, width: 54, height: 34 });
	overlay.strokesHere = () => strokes;
	Object.defineProperty(overlay, "winRef", { value: { devicePixelRatio: 1 } });
	const result = await (overlay as unknown as InkOverlayPlugin).snipSelection();
	return { result, log };
}

describe("the note snip's page", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is filled white before any ink, and the white pen is drawn dark enough to read on it", async () => {
		const { result, log } = await snip([stroke("w", PEN_WHITE)]);
		expect(result.ok, "premise: the snip produced an image").toBe(true);

		const fill = log.findIndex((e) => e.op === "fillRect");
		expect(fill, "premise: the page rectangle is filled").toBeGreaterThan(-1);
		const pageFill = [...log.slice(0, fill)].reverse().find((e) => e.op === "set" && e.prop === "fillStyle");
		expect(hexOf(pageFill?.value), "the rectangle behind the ink is white").toBe("#ffffff");

		const inkSets = log.slice(fill + 1).filter((e) => e.op === "set").map((e) => hexOf(e.value));
		expect(inkSets.length, "premise: the ink set a colour").toBeGreaterThan(0);
		for (const c of inkSets) {
			expect(contrastRatio(lum(c), lum("#ffffff")), `ink colour ${c} reads on the white page`).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
		}
	});

	it("leaves ink that already reads on white as it is", async () => {
		const { log } = await snip([stroke("b", PEN_BLACK)]);
		const fill = log.findIndex((e) => e.op === "fillRect");
		const inkSets = log.slice(fill + 1).filter((e) => e.op === "set").map((e) => hexOf(e.value));
		expect(inkSets).toContain(PEN_BLACK);
	});
});
