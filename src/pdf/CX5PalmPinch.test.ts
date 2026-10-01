import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test/routerHarness";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;
class FakeWheelEvent {
	constructor(type: string, init: Record<string, unknown>) {
		Object.assign(this, { type }, init);
	}
}
g["WheelEvent"] ??= FakeWheelEvent;
g["HTMLElement"] ??= class {};
const HTMLEl = g["HTMLElement"] as { prototype: object };

import { PdfInkController } from "../pdf/PdfInkController";
import { isAppleTouchPlatform, palmRadiusTrustworthy } from "../input/PalmShield";

type Listener = (ev: unknown) => void;
type Touch = { identifier: number; clientX: number; clientY: number; radiusX: number; radiusY: number };

const WIN_NAV = {
	userAgent:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.12.3 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36",
	platform: "Win32",
	maxTouchPoints: 10,
};

interface Rig {
	controller: PdfInkController;
	scroller: Record<string, unknown>;
	wheels: Array<{ deltaY: number; ctrlKey: boolean }>;
	styles: Record<string, string>;
	scale: () => number;
	fire: (
		type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
		changed: Touch[],
		touches: Touch[],
		target?: unknown
	) => { defaultPrevented: boolean; stoppedAtWindow: boolean };
	shield: { rejected: number };
	bridge: { bridged: number };
}

function buildRig(nav = WIN_NAV): Rig {
	let viewerScale = 1;
	const wheels: Array<{ deltaY: number; ctrlKey: boolean }> = [];
	const styles: Record<string, string> = {};
	const winListeners = new Map<string, Listener[]>();
	const elListeners = new Map<string, Listener[]>();

	const win: Record<string, unknown> = {
		devicePixelRatio: 1,
		navigator: nav,
		addEventListener: (type: string, fn: Listener) => {
			const l = winListeners.get(type) ?? [];
			l.push(fn);
			winListeners.set(type, l);
		},
		removeEventListener: (type: string, fn: Listener) => {
			const l = winListeners.get(type) ?? [];
			const i = l.indexOf(fn);
			if (i >= 0) l.splice(i, 1);
		},
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
		requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
		cancelAnimationFrame: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
		getComputedStyle: () => ({
			position: "relative",
			getPropertyValue: (p: string) => (p === "--scale-factor" ? String(viewerScale) : ""),
		}),
	};

	const content = Object.setPrototypeOf(
		{
			setCssStyles: (s: Record<string, string>) => Object.assign(styles, s),
		},
		HTMLEl.prototype
	);
	const page = Object.setPrototypeOf(
		{
			tagName: "DIV",
			className: "page",
			parentElement: null,
			getAttribute: (n: string) => (n === "data-page-number" ? "1" : null),
			getBoundingClientRect: () => ({
				left: 0,
				top: 0,
				right: 1000 * viewerScale,
				bottom: 1500 * viewerScale,
				width: 1000 * viewerScale,
				height: 1500 * viewerScale,
			}),
		},
		HTMLEl.prototype
	);

	const classes = new Set<string>();
	const scroller: Record<string, unknown> = {
		style: { touchAction: "" },
		scrollLeft: 0,
		scrollTop: 0,
		ownerDocument: { defaultView: win },
		setCssStyles(s: { touchAction?: string }) {
			if (s.touchAction !== undefined) (this.style as { touchAction: string }).touchAction = s.touchAction;
		},
		classList: {
			add: (c: string) => void classes.add(c),
			remove: (c: string) => void classes.delete(c),
			contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => {
				const want = on ?? !classes.has(c);
				if (want) classes.add(c);
				else classes.delete(c);
				return want;
			},
		},
		addEventListener: (type: string, fn: Listener) => {
			const l = elListeners.get(type) ?? [];
			l.push(fn);
			elListeners.set(type, l);
		},
		removeEventListener: (type: string, fn: Listener) => {
			const l = elListeners.get(type) ?? [];
			const i = l.indexOf(fn);
			if (i >= 0) l.splice(i, 1);
		},
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
		setPointerCapture() {},
		releasePointerCapture() {},
		querySelector: (sel: string) => {
			if (sel === ".pdfViewer") return content;
			if (sel.startsWith("div.page")) return page;
			return null;
		},
		querySelectorAll: (sel: string) => (sel.startsWith("div.page") ? [page] : []),
		dispatchEvent: (e: { type?: string; ctrlKey?: boolean; deltaY?: number }) => {
			if (e.type === "wheel") {
				wheels.push({ deltaY: e.deltaY ?? 0, ctrlKey: !!e.ctrlKey });
				// The viewer's ctrl+wheel zoom.
				if (e.ctrlKey && typeof e.deltaY === "number") viewerScale *= Math.exp(-e.deltaY * 0.0035);
			}
			return true;
		},
		createDiv: () => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: () => {},
		}),
	};
	scroller.contains = (n: unknown) => n === scroller || n === content || n === page;

	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		() => [],
		() => {}
	);
	(controller as unknown as { bindTo(el: unknown): void }).bindTo(scroller);

	const fire: Rig["fire"] = (type, changed, touches, target = content) => {
		let stopped = false;
		let immediate = false;
		const ev = {
			type,
			target,
			changedTouches: changed,
			touches,
			cancelable: true,
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
			stopPropagation() {
				stopped = true;
			},
			stopImmediatePropagation() {
				stopped = true;
				immediate = true;
			},
		};
		// Capture phase: window first.
		for (const fn of (winListeners.get(type) ?? []).slice()) {
			if (immediate) break;
			fn(ev);
		}
		const stoppedAtWindow = stopped;
		if (!stopped) {
			// Then the scroller's capture listeners, in registration order.
			for (const fn of (elListeners.get(type) ?? []).slice()) {
				if (immediate) break;
				fn(ev);
			}
		}
		return { defaultPrevented: ev.defaultPrevented, stoppedAtWindow };
	};

	const priv = controller as unknown as {
		palmShield: { rejected: number };
		pinchBridge: { bridged: number };
	};
	return {
		controller,
		scroller,
		wheels,
		styles,
		scale: () => viewerScale,
		fire,
		shield: priv.palmShield,
		bridge: priv.pinchBridge,
	};
}

const palm = (x: number, y: number): Touch => ({ identifier: 1, clientX: x, clientY: y, radiusX: 24, radiusY: 24 });
const finger = (id: number, x: number, y: number): Touch => ({ identifier: id, clientX: x, clientY: y, radiusX: 5, radiusY: 5 });

describe("a swallowed palm must not count in the PDF pinch bridge", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => uninstallWindow());

	let rig: Rig;
	beforeEach(() => {
		vi.useFakeTimers();
		rig = buildRig();
	});
	afterEach(() => {
		(rig.controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		vi.useRealTimers();
	});

	it("control: two honest fingertips ARE bridged and zoom (the harness can see a pinch)", () => {
		const a0 = finger(2, 350, 300);
		const b0 = finger(3, 450, 300);
		rig.fire("touchstart", [a0, b0], [a0, b0]);
		expect(rig.bridge.bridged).toBe(1);
		const a1 = finger(2, 300, 300);
		const b1 = finger(3, 500, 300);
		rig.fire("touchmove", [a1, b1], [a1, b1]);
		expect(rig.styles["transform"]).toBe("scale(2)");
		rig.fire("touchend", [b1], [a1]);
		expect(rig.wheels.some((w) => w.ctrlKey)).toBe(true);
	});

	it("control: one finger alone is not bridged", () => {
		const f0 = finger(2, 400, 500);
		const r = rig.fire("touchstart", [f0], [f0]);
		expect(r.defaultPrevented).toBe(false);
		expect(rig.bridge.bridged).toBe(0);
	});

	it("palm (swallowed by the shield) + one finger dragging does not zoom the PDF", () => {
		// Precondition: Windows desktop - shield and bridge both attach.
		expect(palmRadiusTrustworthy(WIN_NAV)).toBe(true);
		expect(isAppleTouchPlatform(WIN_NAV)).toBe(false);
		expect(rig.controller.idle).toBe(true);

		// 1. The heel of the hand lands (radius 24 >= 16): the shield swallows it.
		const p = palm(400, 100);
		const palmDown = rig.fire("touchstart", [p], [p]);
		expect(palmDown.stoppedAtWindow, "precondition: the window guard left the palm to the shield").toBe(false);
		expect(palmDown.defaultPrevented, "precondition: the shield vetoed the palm").toBe(true);
		expect(rig.shield.rejected, "precondition: the shield swallowed the palm").toBe(1);
		expect(rig.bridge.bridged).toBe(0);

		// 2. One finger lands to scroll; the palm is still on the glass, so it is in `touches`.
		const f0 = finger(2, 400, 500);
		const fingerDown = rig.fire("touchstart", [f0], [p, f0]);
		expect(fingerDown.stoppedAtWindow, "precondition: the finger reached the scroller").toBe(false);
		expect.soft(rig.bridge.bridged, "a swallowed palm + one finger was bridged as a pinch").toBe(0);
		expect.soft(fingerDown.defaultPrevented, "the finger's touchstart was claimed (no native scroll)").toBe(false);

		// 3. The finger drags down 200px (only the finger changed).
		const f1 = finger(2, 400, 700);
		rig.fire("touchmove", [f1], [p, f1]);
		expect.soft(rig.styles["transform"] ?? "", "the viewer was CSS-scaled by the palm-to-finger spread").toBe("");

		// 4. The finger lifts.
		const scaleBefore = rig.scale();
		rig.fire("touchend", [f1], [p]);
		vi.advanceTimersByTime(300);
		const ctrlWheels = rig.wheels.filter((w) => w.ctrlKey);
		expect.soft(ctrlWheels, "ctrl+wheel zoom events were dispatched on the PDF scroller").toEqual([]);
		expect(rig.scale(), `viewer scale changed from ${scaleBefore} (a one-finger drag zoomed the PDF)`).toBe(1);
	});

	it("a swallowed palm stays excluded after its radius shrinks", () => {
		const p = palm(400, 100);
		rig.fire("touchstart", [p], [p]);
		const small = finger(1, 400, 100);
		rig.fire("touchmove", [small], [small]);
		const f = finger(2, 400, 500);
		rig.fire("touchstart", [f], [small, f]);
		rig.fire("touchmove", [finger(2, 400, 700)], [small, finger(2, 400, 700)]);
		expect(rig.bridge.bridged).toBe(0);
		expect(rig.wheels).toHaveLength(0);
	});

	for (const next of ["move", "end", "palm-first"] as const) {
		it(`abandons a pinch after a contact flattens, on the next finger ${next}`, () => {
			const a = finger(1, 350, 300), b = finger(2, 450, 300);
			rig.fire("touchstart", [a, b], [a, b]);
			const far = finger(2, 550, 300);
			rig.fire("touchmove", [far], [a, far]);
			expect(rig.styles.transform).toBe("scale(2)");
			const wheels = rig.wheels.length;
			const flat = palm(350, 300);
			rig.fire("touchmove", [flat], [flat, far]);
			expect(rig.shield.rejected).toBe(1);
			if (next === "move") rig.fire("touchmove", [far], [flat, far]);
			else if (next === "end") rig.fire("touchend", [far], [flat]);
			else {
				rig.fire("touchend", [flat], [far]);
				rig.fire("touchend", [far], []);
			}
			expect(rig.styles.transform).toBe("");
			// A duplicate termination must not create a second commit.
			rig.fire("touchend", [far], next === "palm-first" ? [] : [flat]);
			vi.runAllTimers();
			expect(rig.wheels.length).toBe(wheels);
		});
	}

	for (const type of ["touchend", "touchcancel"] as const) {
		it(`reuses an identifier after a swallowed contact's ${type}`, () => {
			const p = palm(350, 300);
			rig.fire("touchstart", [p], [p]);
			rig.fire(type, [p], []);
			const a = finger(1, 350, 300), b = finger(2, 450, 300);
			rig.fire("touchstart", [a, b], [a, b]);
			rig.fire("touchmove", [finger(2, 550, 300)], [a, finger(2, 550, 300)]);
			expect(rig.styles.transform).toBe("scale(2)");
		});
	}

	it("rebind clears an old preview and shield membership", () => {
		const a = finger(1, 350, 300), b = finger(2, 450, 300);
		rig.fire("touchstart", [a, b], [a, b]);
		rig.fire("touchmove", [finger(2, 550, 300)], [a, finger(2, 550, 300)]);
		expect(rig.styles.transform).toBe("scale(2)");
		(rig.controller as unknown as { bindTo(el: unknown): void }).bindTo(rig.scroller);
		expect(rig.styles.transform).toBe("");
		const wheels = rig.wheels.length;
		vi.runAllTimers();
		expect(rig.styles.transform).toBe("");
		expect(rig.wheels).toHaveLength(wheels);
	});

	for (const end of ["touchend", "touchcancel"] as const) {
		it(`honest simultaneous ${end} commits once and ignores repeated termination`, () => {
			const a = finger(1, 350, 300), b = finger(2, 450, 300), far = finger(2, 550, 300);
			rig.fire("touchstart", [a, b], [a, b]);
			rig.fire("touchmove", [far], [a, far]);
			const wheels = rig.wheels.length;
			rig.fire(end, [a, far], []);
			expect(rig.wheels.length).toBe(wheels + 1);
			rig.fire(end, [a, far], []);
			vi.runAllTimers();
			expect(rig.styles.transform).toBe("");
			expect(rig.wheels.length).toBe(wheels + 1);
		});
	}

	for (const action of ["third-finger", "dispose", "other-element"] as const) {
		it(`${action} drops the preview with no late wheel or repaint`, () => {
			const a = finger(1, 350, 300), b = finger(2, 450, 300), far = finger(2, 550, 300);
			rig.fire("touchstart", [a, b], [a, b]);
			rig.fire("touchmove", [far], [a, far]);
			const wheels = rig.wheels.length;
			const bridge = rig.bridge as unknown as { dispose(): void; attach(el: HTMLElement): void };
			if (action === "dispose") bridge.dispose();
			else if (action === "third-finger") {
				const third = finger(3, 400, 350);
				rig.fire("touchstart", [third], [a, far, third]);
			} else bridge.attach({ addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement);
			vi.runAllTimers();
			expect(rig.styles.transform).toBe("");
			expect(rig.wheels.length).toBe(wheels);
		});
	}

	it("Apple touch retains native gestures; Android radii do not reject fingertips", () => {
		for (const nav of [
			{ userAgent: "iPad", platform: "MacIntel", maxTouchPoints: 5 },
			{ userAgent: "Android", platform: "Linux", maxTouchPoints: 5 },
		]) {
			const other = buildRig(nav);
			const a = palm(350, 300), b = { ...palm(450, 300), identifier: 2 };
			const e = other.fire("touchstart", [a, b], [a, b]);
			expect(other.shield.rejected).toBe(0);
			expect(other.bridge.bridged).toBe(nav.userAgent === "iPad" ? 0 : 1);
			if (nav.userAgent === "iPad") expect(e.defaultPrevented).toBe(false);
			(other.controller as unknown as { router: { dispose(): void } }).router.dispose();
		}
	});
});
