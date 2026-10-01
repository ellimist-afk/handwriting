/**
 * C2 red-first cells for audit item 175: "Diagnostics:
 * show presentation capture" samples the wrong screen area at a zoom other
 * than 100% and takes its background from one corner only (audit 175,
 * PresentProbe.ts capturePresented).
 *
 * The third root cause, "always captures the main window's webContents"
 * (popouts), has its own cell at the end: the pane's window is passed in.
 *
 * Rig: window.require is faked the way Obsidian's renderer provides it
 * (electron.remote.getCurrentWebContents().capturePage, and electron.webFrame
 * for the page zoom); the captured image is a hand-built BGRA bitmap.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePresented } from "../inline/PresentProbe";

type Rect = { x: number; y: number; width: number; height: number };
const g = globalThis as unknown as { window?: Record<string, unknown> };
let before: Record<string, unknown> | undefined;

/** A width x height BGRA bitmap of one background colour, with `paint` overrides. */
function bitmap(width: number, height: number, bg: [number, number, number], paint: Array<[number, number, [number, number, number]]> = []) {
	const buf = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		buf[i * 4] = bg[2]; // B
		buf[i * 4 + 1] = bg[1];
		buf[i * 4 + 2] = bg[0]; // R
		buf[i * 4 + 3] = 255;
	}
	for (const [x, y, rgb] of paint) {
		const o = (y * width + x) * 4;
		buf[o] = rgb[2];
		buf[o + 1] = rgb[1];
		buf[o + 2] = rgb[0];
	}
	return buf;
}

function rig(zoom: number, image: { w: number; h: number; buf: Uint8Array }) {
	const rects: Rect[] = [];
	const electron = {
		remote: {
			getCurrentWebContents: () => ({
				capturePage: async (rect: Rect) => {
					rects.push(rect);
					return { getSize: () => ({ width: image.w, height: image.h }), getBitmap: () => image.buf };
				},
			}),
		},
		webFrame: { getZoomFactor: () => zoom },
	};
	g.window = Object.assign(g.window ?? globalThis, {
		devicePixelRatio: zoom,
		require: (m: string) => {
			if (m === "electron") return electron;
			throw new Error("unexpected require " + m);
		},
	});
	return rects;
}

beforeEach(() => {
	before = g.window;
	if (!g.window) g.window = globalThis as unknown as Record<string, unknown>;
});
afterEach(() => {
	delete (g.window as Record<string, unknown>).require;
	g.window = before;
});

describe("C2-175: presentation capture geometry", () => {
	const box = { x: 100, y: 200, w: 300, h: 80 };
	const flat = { w: 4, h: 4, buf: bitmap(4, 4, [10, 10, 10]) };

	it("control: at 100% zoom the rect handed to capturePage is the css box", async () => {
		const rects = rig(1, flat);
		await capturePresented(box);
		expect(rects).toEqual([{ x: 100, y: 200, width: 300, height: 80 }]);
	});

	it("at 150% zoom the rect is in window DIPs (css box x 1.5)", async () => {
		const rects = rig(1.5, flat);
		await capturePresented(box);
		// capturePage works in DIPs: css px x page zoom factor.
		expect(rects).toEqual([{ x: 150, y: 300, width: 450, height: 120 }]);
	});

	it("control: a flat capture counts nothing presented and takes its size from the image", async () => {
		rig(1, flat);
		const r = await capturePresented(box);
		expect(r.ok).toBe(true);
		expect(r.presentedPx).toBe(0);
		expect(r.sampledPx).toBe(16);
	});

	it("ink touching one corner does not become the background", async () => {
		// 6x6 of background (10,10,10); ink at the top-left corner and two pixels inside.
		const ink: [number, number, number] = [200, 20, 20];
		const image = { w: 6, h: 6, buf: bitmap(6, 6, [10, 10, 10], [[0, 0, ink], [2, 2, ink], [3, 3, ink]]) };
		rig(1, image);
		const r = await capturePresented(box);
		expect(r.ok).toBe(true);
		// Three of four corners are background, so that is the background: exactly the three ink pixels differ.
		expect(r.presentedPx, "counted against the ink corner: nearly every background pixel reads as presented").toBe(3);
	});
	it("a note in a popout is captured from the popout's own window, not the main one", async () => {
		const mainRects = rig(1, flat);
		const popoutRects: Rect[] = [];
		const popout = {
			require: (m: string) => {
				if (m !== "electron") throw new Error("unexpected require " + m);
				return {
					remote: {
						getCurrentWebContents: () => ({
							capturePage: async (rect: Rect) => {
								popoutRects.push(rect);
								return { getSize: () => ({ width: flat.w, height: flat.h }), getBitmap: () => flat.buf };
							},
						}),
					},
					webFrame: { getZoomFactor: () => 1 },
				};
			},
		};
		const capture = capturePresented as unknown as (b: typeof box, ink: null, win: unknown) => Promise<unknown>;
		await capture(box, null, popout);
		expect(mainRects, "the main window is not the note's window").toEqual([]);
		expect(popoutRects).toEqual([{ x: 100, y: 200, width: 300, height: 80 }]);
	});
	it("a popout with no require of its own reports the capture unavailable, never the main window's pixels", async () => {
		const mainRects = rig(1, flat);
		const capture = capturePresented as unknown as (b: typeof box, ink: null, win: unknown) => Promise<{ ok: boolean; detail: string }>;
		const r = await capture(box, null, {});
		expect(mainRects, "the main window is not the note's window").toEqual([]);
		expect(r.ok).toBe(false);
		expect(r.detail).toBe("popout capture unavailable");
	});
});
