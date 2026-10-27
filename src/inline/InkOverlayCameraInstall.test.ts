/**
 * The camera pin - the sync that holds the camera on the note surface for one
 * frame, from the scroll, the zoom and the document top - lives in
 * InkOverlayCamera.ts and is installed on InkOverlayPlugin.prototype when
 * InkOverlay.ts loads. Two things a type check cannot see are held here, as
 * the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the camera file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the camera file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. The moved name must be an own property of the prototype with
 * the descriptor a class method has, and it may not be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; every scroll, zoom and repaint would then throw
 * instead of pinning the camera.
 */
import { describe, expect, it } from "vitest";

import { installInkOverlayCamera } from "./InkOverlayCamera";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import cameraRaw from "./InkOverlayCamera.ts?raw";

const MOVED = ["syncCamera"] as const;

/** What the camera file takes back from InkOverlay.ts: three camera constants and helpers, and the class as a type. */
const BACK = ["CAMERA_STILL_BACKING_PX", "SCALE_EPSILON", "cameraWithin", "InkOverlayPlugin"] as const;

function bareOverlay(): { overlay: InkOverlayPlugin; containerReads: () => number } {
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	let reads = 0;
	Object.defineProperty(overlay, "container", {
		get() {
			reads++;
			return null;
		},
		configurable: true,
	});
	return { overlay, containerReads: () => reads };
}

describe("camera pin method on the overlay prototype", () => {
	it("loads with the camera file imported first, and a bare overlay with no container pins nothing", () => {
		expect(typeof installInkOverlayCamera).toBe("function");
		const { overlay, containerReads } = bareOverlay();
		overlay.deferPinchRaster = () => false;
		expect(overlay.syncCamera()).toBeUndefined();
		// No container: the sync reads it once and stops there.
		expect(containerReads()).toBe(1);
	});

	it("a pinch-held raster defers the sync before it reads the container", () => {
		const { overlay, containerReads } = bareOverlay();
		overlay.deferPinchRaster = () => true;
		overlay.syncCamera();
		expect(containerReads()).toBe(0);
	});

	it("the moved name is a prototype method with a class method's descriptor, declared once in the camera file and not in the class body", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const camera = cameraRaw.replace(/\r\n/g, "\n");
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
			expect(new RegExp(`^\\t(private )?${name}\\(`, "m").test(text), `${name} is still declared in the class body`).toBe(false);
			expect(camera.match(new RegExp(`^\\tfunction ${name}\\(`, "gm"))?.length ?? 0, `${name} in InkOverlayCamera.ts`).toBe(1);
		}
	});

	it("is installed once, after the class body closes, and takes back only its four names", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const camera = cameraRaw.replace(/\r\n/g, "\n");
		const call = "installInkOverlayCamera(InkOverlayPlugin.prototype);";
		expect(text.split(call).length - 1).toBe(1);
		const classStart = text.indexOf("export class InkOverlayPlugin {");
		const classEnd = text.indexOf("\n}\n", classStart);
		expect(classStart).toBeGreaterThan(-1);
		expect(text.indexOf(call)).toBeGreaterThan(classEnd);
		const back = camera.match(/^import \{([^}]*)\} from "\.\/InkOverlay";/m);
		expect(back?.[1]?.split(",").map((s) => s.trim().replace(/^type /, "")).sort()).toEqual([...BACK].sort());
	});
});
