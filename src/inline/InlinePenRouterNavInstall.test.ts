/**
 * The pen router's navigation (the pinch, the finger-ink preparation, the assist
 * pan and the fling with its overscroll pull) lives in InlinePenRouterNav.ts and
 * is installed on InlinePenRouter.prototype when InlinePenRouter.ts loads. Four
 * things a type check cannot see are held here, as the install tests of the other
 * split files hold them for theirs.
 *
 * LOAD ORDER. This file imports the navigation file first. It takes only a type
 * from InlinePenRouter.ts, so the two form no cycle at run time; the one-door cell
 * below fails if a value import comes back, which would make the load order matter.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * gesture ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * navigation file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The navigation file names nothing of the router at run time.
 */
import { describe, expect, it, vi } from "vitest";

import { installInlinePenRouterNav } from "./InlinePenRouterNav";
import { InlinePenRouter } from "./InlinePenRouter";
import routerRaw from "./InlinePenRouter.ts?raw";
import navRaw from "./InlinePenRouterNav.ts?raw";

const MOVED = [
	"beginPinch",
	"pinchCentroid",
	"rebasePinch",
	"updatePinch",
	"endPinch",
	"prepareFingerInk",
	"fingerInkContactActive",
	"finishFingerInkPreparation",
	"setCanvasMomentumDisabled",
	"beginAssist",
	"yieldAssistToHost",
	"cameraTransformChanged",
	"assistMove",
	"endAssist",
	"startFling",
	"carryScrollBy",
	"accrueOverscrollPull",
	"releaseOverscrollPull",
	"liftAgainstAnEnd",
	"dragBeginsAgainstAnEnd",
	"cancelFling",
] as const;

const routerSrc = routerRaw.replace(/\r\n/g, "\n");
const navSrc = navRaw.replace(/\r\n/g, "\n");

/** A router with no host, as the other install tests build theirs: the prototype and the fields a method reads. */
function bareRouter(fields: Record<string, unknown>): InlinePenRouter {
	const router = Object.create(InlinePenRouter.prototype) as InlinePenRouter;
	for (const [name, value] of Object.entries(fields)) {
		Object.defineProperty(router, name, { value, writable: true, configurable: true });
	}
	return router;
}

/** The scroller sizes the two end tests read. */
function scroller(sizes: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollLeft: number; scrollTop: number }) {
	return sizes;
}

describe("navigation methods on the pen router prototype", () => {
	it("load with the navigation file imported first", () => {
		expect(typeof installInlinePenRouterNav).toBe("function");
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InlinePenRouter.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});

	it("each moved name is declared once in the navigation file and not in the class", () => {
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = routerSrc.slice(classStart, routerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = navSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InlinePenRouter\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InlinePenRouterNav.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the router installs once, after the class closing brace", () => {
		const call = "installInlinePenRouterNav(InlinePenRouter.prototype);";
		expect(routerSrc.split(call).length - 1).toBe(1);
		const classStart = routerSrc.indexOf("export class InlinePenRouter {");
		const classEnd = routerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(routerSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the navigation file takes only a type from the router", () => {
		const imports = [...navSrc.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"\.\/InlinePenRouter";/gm)];
		expect(imports.length).toBe(1);
		expect(imports[0]![1]).toBeDefined();
	});

	it("fingerInkContactActive is false with nothing down and true for each of its four causes", () => {
		const fields = () => ({
			activePenId: null,
			guardTouches: new Set<number>(),
			swallowedTouches: new Set<number>(),
			liveTouchIds: new Set<number>(),
		});
		expect(bareRouter(fields()).fingerInkContactActive()).toBe(false);
		expect(bareRouter({ ...fields(), activePenId: 4 }).fingerInkContactActive()).toBe(true);
		expect(bareRouter({ ...fields(), guardTouches: new Set([1]) }).fingerInkContactActive()).toBe(true);
		expect(bareRouter({ ...fields(), swallowedTouches: new Set([1]) }).fingerInkContactActive()).toBe(true);
		expect(bareRouter({ ...fields(), liveTouchIds: new Set([1]) }).fingerInkContactActive()).toBe(true);
	});

	it("releaseOverscrollPull zeroes both pulls and calls the host once, and does nothing when both are zero", () => {
		const onOverscrollRelease = vi.fn();
		const quiet = bareRouter({ overscrollPullX: 0, overscrollPullY: 0, cb: { onOverscrollRelease } });
		quiet.releaseOverscrollPull();
		expect(onOverscrollRelease).not.toHaveBeenCalled();

		const pulledX = bareRouter({ overscrollPullX: 12, overscrollPullY: 0, cb: { onOverscrollRelease } });
		pulledX.releaseOverscrollPull();
		expect(onOverscrollRelease).toHaveBeenCalledTimes(1);
		expect({ x: pulledX.overscrollPullX, y: pulledX.overscrollPullY }).toEqual({ x: 0, y: 0 });

		const pulledY = bareRouter({ overscrollPullX: 0, overscrollPullY: -7, cb: { onOverscrollRelease } });
		pulledY.releaseOverscrollPull();
		expect(onOverscrollRelease).toHaveBeenCalledTimes(2);
		expect({ x: pulledY.overscrollPullX, y: pulledY.overscrollPullY }).toEqual({ x: 0, y: 0 });
	});

	it("liftAgainstAnEnd and dragBeginsAgainstAnEnd are false without an allowance and answer from the scroller with one", () => {
		const tall = { scrollWidth: 400, clientWidth: 400, scrollHeight: 1600, clientHeight: 600, scrollLeft: 0 };
		const allowance = { overscrollAllowancePx: () => 40 };
		const none = { overscrollAllowancePx: () => 0 };
		const at = (scrollTop: number, cb: object) =>
			bareRouter({ cb, scrollEl: scroller({ ...tall, scrollTop }) });

		// No allowance: false on both, at an end and not.
		expect(at(0, {}).liftAgainstAnEnd()).toBe(false);
		expect(at(0, {}).dragBeginsAgainstAnEnd()).toBe(false);
		expect(at(0, none).liftAgainstAnEnd()).toBe(false);
		expect(at(0, none).dragBeginsAgainstAnEnd()).toBe(false);

		// An allowance, the scroller at its top and at its bottom end: true on both.
		expect(at(0, allowance).liftAgainstAnEnd()).toBe(true);
		expect(at(0, allowance).dragBeginsAgainstAnEnd()).toBe(true);
		expect(at(1000, allowance).liftAgainstAnEnd()).toBe(true);
		expect(at(1000, allowance).dragBeginsAgainstAnEnd()).toBe(true);

		// Mid-page on a note that fits sideways: the lift is narrower and says no, the drag counts the axis with no range and says yes.
		expect(at(500, allowance).liftAgainstAnEnd()).toBe(false);
		expect(at(500, allowance).dragBeginsAgainstAnEnd()).toBe(true);

		// Mid-page with range on both axes: no on both.
		const wide = bareRouter({
			cb: allowance,
			scrollEl: scroller({ scrollWidth: 1200, clientWidth: 400, scrollHeight: 1600, clientHeight: 600, scrollLeft: 300, scrollTop: 500 }),
		});
		expect(wide.liftAgainstAnEnd()).toBe(false);
		expect(wide.dragBeginsAgainstAnEnd()).toBe(false);

		// A note with no range on either axis: yes on both.
		const fits = bareRouter({
			cb: allowance,
			scrollEl: scroller({ scrollWidth: 400, clientWidth: 400, scrollHeight: 600, clientHeight: 600, scrollLeft: 0, scrollTop: 0 }),
		});
		expect(fits.liftAgainstAnEnd()).toBe(true);
		expect(fits.dragBeginsAgainstAnEnd()).toBe(true);
	});

	it("cancelFling with no glide running still sends a standing pull home, and with one running cancels its frame first", () => {
		const onOverscrollRelease = vi.fn();
		const cancelAnimationFrame = vi.fn();
		const view = { cancelAnimationFrame };
		const scrollEl = { ownerDocument: { defaultView: view } };

		const idle = bareRouter({ flingRaf: 0, overscrollPullX: 9, overscrollPullY: 0, cb: { onOverscrollRelease }, scrollEl });
		idle.cancelFling();
		expect(cancelAnimationFrame).not.toHaveBeenCalled();
		expect(onOverscrollRelease).toHaveBeenCalledTimes(1);
		expect(idle.overscrollPullX).toBe(0);

		const gliding = bareRouter({ flingRaf: 7, overscrollPullX: 0, overscrollPullY: 0, cb: { onOverscrollRelease }, scrollEl });
		gliding.cancelFling();
		expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
		expect(gliding.flingRaf).toBe(0);
		expect(onOverscrollRelease).toHaveBeenCalledTimes(1);
	});
});
