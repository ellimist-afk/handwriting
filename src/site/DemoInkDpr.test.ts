import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The website demo's canvas after the device pixel ratio changes (a window dragged to another monitor).
 *
 * The demo sizes its canvas backing from the ratio when it starts and again when the canvas box changes. A ratio change that
 * leaves the box alone calls neither, yet every paint scales the drawing by the ratio it reads then. The backing and the
 * scale must agree whenever the canvas is painted: ink is drawn at (CSS size x scale) device pixels into a backing that is
 * (CSS size x the ratio it was sized at).
 *
 * The module wires itself to the page when it loads, so each cell stubs the few globals it touches, loads it fresh, and
 * drives the canvas through the pointer events the page would deliver.
 */

type Call = { name: string; args: unknown[] };

const RECT = { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0 };

function fakeContext(calls: Call[]): CanvasRenderingContext2D {
	const own: Record<string, unknown> = {};
	return new Proxy(own, {
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (key in target) return target[key];
			return (...args: unknown[]) => {
				calls.push({ name: key, args });
			};
		},
		set(target, key, value) {
			target[key as string] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

interface Rig {
	canvas: { width: number; height: number };
	calls: Call[];
	setDpr(v: number): void;
	fire(type: string, ev: Record<string, unknown>): void;
}

async function mountDemo(startDpr: number): Promise<Rig> {
	const calls: Call[] = [];
	const listeners = new Map<string, (ev: unknown) => void>();
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => fakeContext(calls),
		getBoundingClientRect: () => RECT,
		addEventListener: (type: string, fn: (ev: unknown) => void) => void listeners.set(type, fn),
		setPointerCapture: () => {},
	};
	const win = {
		devicePixelRatio: startDpr,
		requestAnimationFrame: () => 1,
		matchMedia: () => ({ matches: true }),
	};
	vi.stubGlobal("window", win);
	vi.stubGlobal("ResizeObserver", class { observe() {} });
	vi.stubGlobal("document", {
		readyState: "complete",
		querySelector: (sel: string) => (sel === "#ink-demo" ? canvas : null),
		querySelectorAll: () => [],
		addEventListener: () => {},
	});
	vi.resetModules();
	await import("./DemoInk");
	return {
		canvas,
		calls,
		setDpr: (v) => void (win.devicePixelRatio = v),
		fire: (type, ev) => listeners.get(type)?.({ preventDefault() {}, button: 0, pointerType: "pen", pressure: 0.5, ...ev }),
	};
}

beforeEach(() => {
	vi.unstubAllGlobals();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

/** The drawing scale of the last full paint: the `scale` call that follows the last `setTransform` reset. */
function lastScale(calls: Call[]): number {
	let at = -1;
	calls.forEach((c, i) => {
		if (c.name === "setTransform") at = i;
	});
	const scale = calls.slice(at + 1).find((c) => c.name === "scale");
	if (!scale) throw new Error("no scale call after the last reset");
	return scale.args[0] as number;
}

async function writeOneStroke(rig: Rig): Promise<void> {
	const at = (x: number, y: number, t: number) => ({ pointerId: 1, clientX: x, clientY: y, timeStamp: t });
	rig.fire("pointerdown", at(10, 10, 0));
	for (let i = 1; i <= 8; i++) rig.fire("pointermove", at(10 + i * 8, 10 + i * 3, i * 8));
	rig.fire("pointerup", at(74, 34, 72));
}

describe("the demo canvas when the device pixel ratio changes without a size change", () => {
	it("the harness holds: at ratio 2 the backing is twice the box and a paint scales by 2", async () => {
		const rig = await mountDemo(2);
		expect(rig.canvas.width).toBe(200);
		expect(rig.canvas.height).toBe(100);
		await writeOneStroke(rig);
		expect(lastScale(rig.calls)).toBe(2);
		expect(rig.canvas.width / RECT.width).toBe(2);
	});

	it("after the ratio drops to 1 with no box change, a paint scales the drawing by the backing's own ratio", async () => {
		const rig = await mountDemo(2);
		rig.setDpr(1);
		await writeOneStroke(rig);
		expect(rig.calls.some((c) => c.name === "scale"), "premise: the stroke was painted").toBe(true);
		expect(lastScale(rig.calls), "the drawing scale matches the backing pixels per CSS pixel").toBe(rig.canvas.width / RECT.width);
	});

	it("after the ratio rises with no box change, the backing grows to match and a paint scales by the new ratio", async () => {
		const rig = await mountDemo(1);
		expect(rig.canvas.width).toBe(100);
		rig.setDpr(2);
		await writeOneStroke(rig);
		expect(rig.canvas.width, "the backing is sized again at the new ratio").toBe(200);
		expect(rig.canvas.height).toBe(100);
		expect(lastScale(rig.calls)).toBe(2);
	});
});
