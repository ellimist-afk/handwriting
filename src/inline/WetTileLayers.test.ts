/**
 * Arm E: the wet tile is a sixth ink canvas, and every place that walks the
 * ink canvases as a list must see it. A pinch hides blank layers and
 * restores them; an unmount releases every backing. A tile missed by
 * either list stays visible over a pinch preview, or keeps its backing
 * after a note switch.
 *
 * Contract: the overlay holds the tile canvas as `wetTileCanvas`, and the
 * wet renderer reports its blankness through `provenBlank`, as the other
 * layers do.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";

type Fields = Record<string, unknown>;
const noop = (): undefined => undefined;

function canvas(name: string): Fields {
	let w = 640, h = 480;
	const style: Record<string, string> = { visibility: "" };
	const c: Fields = {
		__name: name,
		style,
		setCssStyles: (s: Record<string, string>) => Object.assign(style, s),
	};
	Object.defineProperties(c, {
		width: { get: () => w, set: (v: number) => { w = v; }, enumerable: true },
		height: { get: () => h, set: (v: number) => { h = v; }, enumerable: true },
	});
	return c;
}

function rig() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const layers = {
		committed: canvas("committed"), wet: canvas("wet"), tail: canvas("tail"),
		highlight: canvas("highlight"), highlightWet: canvas("highlightWet"), wetTile: canvas("wetTile"),
	};
	o.committedCanvas = layers.committed;
	o.wetCanvas = layers.wet;
	o.tailCanvas = layers.tail;
	o.highlightCanvas = layers.highlight;
	o.highlightWetCanvas = layers.highlightWet;
	o.wetTileCanvas = layers.wetTile;
	// Every layer blank: a pinch hides all of them.
	o.committedBlank = true;
	o.highlightBlank = true;
	o.wet = { provenBlank: true };
	o.highlightWet = { provenBlank: true };
	o.tail = { provenBlank: true };
	(o as { pinchHiddenCanvases: Map<unknown, string> }).pinchHiddenCanvases = new Map();
	o.restorePinchLayers = noop;
	o.preparePinchComposite = () => false;
	o.armPinchLayerRestore = noop;
	return { o, layers };
}

describe("arm E: the wet tile is in every ink canvas list", () => {
	it("the overlay has a wet tile canvas once mounted", () => {
		// Read from the prototype's own source: a field that nothing assigns
		// cannot be the sixth layer.
		const src = String(Object.getOwnPropertyNames(InkOverlayPlugin.prototype)
			.map(k => { try { return String((InkOverlayPlugin.prototype as unknown as Fields)[k]); } catch { return ""; } }).join("\n"));
		expect(src.includes("wetTileCanvas"), "no method of the overlay touches wetTileCanvas").toBe(true);
	});

	it("a pinch hides a blank wet tile with the other five blank layers", () => {
		const { o, layers } = rig();
		(o.hideBlankPinchLayers as () => void).call(o);
		for (const [name, c] of Object.entries(layers)) {
			expect((c.style as Record<string, string>).visibility, `${name} stayed visible over the pinch`).toBe("hidden");
		}
	});

	it("unmount's release sizes the wet tile to 0x0 with the other five", () => {
		const { o, layers } = rig();
		(o.releaseBackings as () => void).call(o);
		for (const [name, c] of Object.entries(layers)) {
			expect([c.width, c.height], `${name} kept its backing`).toEqual([0, 0]);
		}
	});
});
