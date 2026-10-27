/**
 * The diagnostics methods live in InkOverlayDiagnostics.ts and are installed
 * on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type
 * check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the diagnostics
 * file imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the diagnostics file first,
 * so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that report or probe ran on a device with diagnostics on.
 */
import { describe, expect, it } from "vitest";

import { installDiagnostics } from "./InkOverlayDiagnostics";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"zoomReport",
	"routerCounters",
	"latencyReport",
	"currentTargetBox",
	"censusReport",
	"presentationReport",
	"recordCommitDiagnostics",
	"probeStrokeLayers",
	"strokeScreenSample",
	"topElementAtStroke",
	"captureProbeGeometry",
	"surfaceReport",
] as const;

describe("diagnostics methods on the overlay prototype", () => {
	it("load with the diagnostics file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installDiagnostics).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		expect(overlay.routerCounters()).toEqual({ downs: 0, ups: 0, backstops: 0, silentLifts: 0, palms: 0 });
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});
});
