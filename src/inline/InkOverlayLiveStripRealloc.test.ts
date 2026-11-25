/**
 * The stroke being drawn, across a reallocation of the drawing canvases with the pen still down.
 *
 * The resize arm sizes every layer, the wet ones included, and a sized canvas is blank. The wet renderer only appends: each
 * strip piece starts where the last one ended. So a graphics reset (`contextrestored`) or a backing change (the window's
 * device pixel ratio) mid-stroke left the stroke so far blank until the lift, while the tip kept drawing. The strip so far
 * must be back by the next frame, the same strip an unreset stroke has; the next piece must start where it did; and a frame
 * with no reallocation must draw nothing again.
 *
 * The rig is the repaint rig with `sized` (real handleResize, real restore listeners, the real pen-down and raw-move path),
 * with the wet, wet highlight and wet tile canvases swapped for canvases that log every call their context takes and every
 * size write, so a strip is compared by what was drawn, in order. The renderers on them are real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InkOverlayPlugin, setInlineTool, getInlineTool } from "./InkOverlay";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { openRepaintRig, type RepaintRig } from "./overlayRig.testutil";

const noHooks = { onCommittedDraw: () => undefined, onPostDraw: () => undefined };
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

type Fields = Record<string, unknown>;
type Tool = "pen" | "highlighter";
interface Op { c: string; op: string; args: unknown[] }

/** What a drawn strip is: the path, its fill and the style it was filled with. Placement (transforms, tile moves) is not. */
const GEOMETRY = new Set([
	"beginPath", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "arc", "arcTo", "ellipse", "rect", "closePath",
	"fill", "stroke", "set fillStyle", "set strokeStyle", "set lineWidth", "set lineCap", "set lineJoin", "set globalAlpha",
]);
const geometry = (ops: readonly Op[]): string[] => ops.filter((o) => GEOMETRY.has(o.op)).map((o) => `${o.op}(${o.args.map(String).join(",")})`);
const fills = (ops: readonly Op[]): number => ops.filter((o) => o.op === "fill").length;

/** A canvas whose context logs every call and every property write, and whose size writes and restores are logged too. */
function loggingCanvas(name: string, log: Op[]) {
	let w = 300;
	let h = 150;
	const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	const style: Record<string, string> = {};
	const el = {
		style,
		setCssStyles: (s: Record<string, string>) => void Object.assign(style, s),
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
		addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
			let set = listeners.get(type);
			if (!set) listeners.set(type, (set = new Set()));
			set.add(fn);
		},
		removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void listeners.get(type)?.delete(fn),
		getContext: () => ctx,
	} as Record<string, unknown>;
	const state: Record<string, unknown> = {};
	const ctx = new Proxy(state, {
		get(target, key) {
			if (key === "canvas") return el;
			if (key === "getContextAttributes") return () => ({ desynchronized: false });
			if (key === "isContextLost") return () => false;
			if (typeof key !== "string") return undefined;
			if (key in target) return target[key];
			return (...args: unknown[]) => void log.push({ c: name, op: key, args });
		},
		set(target, key, value) {
			if (typeof key === "string") {
				target[key] = value;
				log.push({ c: name, op: `set ${key}`, args: [value] });
			}
			return true;
		},
	});
	Object.defineProperties(el, {
		width: { get: () => w, set: (v: number) => { w = v; log.push({ c: name, op: "size", args: ["w", v] }); } },
		height: { get: () => h, set: (v: number) => { h = v; log.push({ c: name, op: "size", args: ["h", v] }); } },
	});
	return {
		el: el as unknown as HTMLCanvasElement,
		/** The browser gives the backing back blank, then fires `contextrestored`. */
		restore(): void {
			log.push({ c: name, op: "restored", args: [] });
			const ev = new Event("contextrestored");
			for (const fn of [...(listeners.get("contextrestored") ?? [])]) {
				if (typeof fn === "function") fn(ev);
				else fn.handleEvent(ev);
			}
		},
	};
}

interface Live {
	rig: RepaintRig;
	o: Fields;
	log: Op[];
	wet: ReturnType<typeof loggingCanvas>;
	highlightWet: ReturnType<typeof loggingCanvas>;
	tile: ReturnType<typeof loggingCanvas>;
	win: { devicePixelRatio: number };
	/** Calls to the live renderer's beginStroke after the pen-down's own: each one is the strip drawn again from its start. */
	replays: () => number;
	renderer: () => WetInkRenderer;
	/** The canvas name the live strip draws on (its full canvas; the tile is "tile"). */
	full: string;
	move: (from: number, to: number) => void;
}

const sample = (i: number) => ({ x: 120 + i * 7, y: 220 + i * 3, pressure: 0.35 + (i % 4) * 0.1, timestamp: 1 + i * 8, tiltX: 0, tiltY: 0 });
const penEv = (t: number) => ({ pointerType: "pen", buttons: 1, button: 0, pointerId: 7, timeStamp: t, clientX: 0, clientY: 0, shiftKey: false });

/**
 * A sized rig at backing 2 with the logging wet canvases mounted and sized by a real arm pass, then a pen-down with `tool`.
 * `withTile`: the page places a canvas by CSS translate (the rig has no CSS, so the overlay's one answer is set by hand
 * before the arm pass), so the pen's strips draw through the wet tile.
 */
async function openLive(tool: Tool, withTile = false): Promise<Live> {
	const rig = await openRepaintRig(1, noHooks, { dpr: 2, sized: true });
	const o = rig.overlay;
	rig.deliverPaintCallbacks();
	const log: Op[] = [];
	const wet = loggingCanvas("wet", log);
	const highlightWet = loggingCanvas("highlightWet", log);
	const tile = loggingCanvas("tile", log);
	o.wetCanvas = wet.el;
	o.highlightWetCanvas = highlightWet.el;
	o.wetTileCanvas = tile.el;
	// Mount's renderers, on these canvases.
	const w = new WetInkRenderer(wet.el, false);
	w.smooth = true;
	w.shape = true;
	const hw = new WetInkRenderer(highlightWet.el, false);
	hw.smooth = true;
	o.wet = w;
	o.highlightWet = hw;
	o.activeWet = w;
	// The restore listeners on the canvases the overlay now has, and one arm pass that sizes them, as mount's resize does.
	proto.watchBackingRestore!.call(o);
	o.backingRestored = true;
	if (withTile) o.translateSupport = true;
	proto.handleResize!.call(o);
	rig.deliverPaintCallbacks();
	expect(wet.el.width, "precondition: the arm sized the wet canvas").toBeGreaterThan(300);
	expect(highlightWet.el.width, "precondition: the arm sized the wet highlight canvas").toBe(wet.el.width);

	// What the pen-down reaches that this rig lacks, each inert here (as in InkOverlayBackingRestore.test.ts).
	o.router = { refreshRect: () => undefined, cameraTransformChanged: () => undefined };
	Object.defineProperty(o.view as object, "hasFocus", { value: true, configurable: true });
	(o.selection as Fields).clear = () => false;
	o.ensurePenTools = () => undefined;
	o.startFrameTicker = () => undefined;
	o.penStyle = { ...DEFAULT_PEN };
	o.highlighterStyle = { ...HIGHLIGHTER_PEN };

	setInlineTool(tool);
	let begins = 0;
	for (const r of [w, hw]) {
		const real = r.beginStroke.bind(r);
		r.beginStroke = (...a: Parameters<WetInkRenderer["beginStroke"]>) => {
			begins++;
			real(...a);
		};
	}
	const s0 = sample(0);
	(proto.penDown as (s: unknown, e: unknown) => void).call(o, s0, penEv(s0.timestamp));
	expect(o.mode, "precondition: a stroke is in flight").toBe("ink");
	expect(o.activeWet, "precondition: the tool's wet layer").toBe(tool === "highlighter" ? hw : w);
	const pendown = begins;
	expect(pendown, "precondition: the pen-down began the strip").toBe(1);
	return {
		rig,
		o,
		log,
		wet,
		highlightWet,
		tile,
		win: (o.view as { dom: { ownerDocument: { defaultView: { devicePixelRatio: number } } } }).dom.ownerDocument.defaultView,
		replays: () => begins - pendown,
		renderer: () => o.activeWet as WetInkRenderer,
		full: tool === "highlighter" ? "highlightWet" : "wet",
		move(from: number, to: number) {
			const batch = [];
			for (let i = from; i <= to; i++) batch.push(sample(i));
			(proto.penRaw as (s: unknown[], e: unknown) => void).call(o, batch, penEv(batch[batch.length - 1]!.timestamp));
		},
	};
}

/**
 * What the live layer still holds of what was drawn since its full canvas was last blanked (a size write or a restore): the
 * full canvas's ops, the tile's ops carried into them where the tile is copied in, and the tile's ops since its last wipe.
 * Tile ops wiped (a clear or a size write) before any copy hold nowhere and are dropped.
 */
function sinceBlank(live: Live): Op[] {
	let at = -1;
	live.log.forEach((op, i) => {
		if (op.c === live.full && (op.op === "size" || op.op === "restored")) at = i;
	});
	const held: Op[] = [];
	let onTile: Op[] = [];
	for (const op of live.log.slice(at + 1)) {
		if (op.c === "tile") {
			if (op.op === "clearRect" || op.op === "size") onTile = [];
			else onTile.push(op);
		} else if (op.c === live.full) {
			if (op.op === "drawImage" && op.args[0] === live.tile.el) held.push(...onTile);
			else held.push(op);
		}
	}
	return [...held, ...onTile];
}

const ribbon = (live: Live) => {
	const end = live.renderer().stripEnd();
	return end ? { ...end } : undefined;
};

/** Every reallocation the cells drive, mid-stroke. */
const REALLOCS = {
	"a backing change (the window's device pixel ratio goes from 2 to 1)": (live: Live) => {
		live.win.devicePixelRatio = 1;
		proto.handleResize!.call(live.o);
		live.rig.deliverPaintCallbacks();
	},
	"a graphics reset (the wet canvas given back blank)": (live: Live) => {
		(live.full === "wet" ? live.wet : live.highlightWet).restore();
		const passes = live.rig.deliverPaintCallbacks();
		expect(passes, "precondition: the restore's frame ran").toBeGreaterThan(0);
	},
} as const;

/**
 * Both rigs draw the same stroke so far; `realloc` hits one of them mid-stroke. By the next frame its layer holds the strip
 * so far again, the same strip, and its next piece is the unreset stroke's next piece.
 */
async function stripBack(tool: Tool, realloc: (live: Live) => void, withTile: boolean): Promise<void> {
	const ref = await openLive(tool, withTile);
	const live = await openLive(tool, withTile);
	for (const l of [ref, live]) l.move(1, 8);
	const drawn = geometry(live.log.filter((op) => op.c === live.full || op.c === "tile"));
	expect(drawn, "precondition: the stroke drew a strip").not.toEqual([]);
	expect(drawn, "precondition: both rigs drew the same strip").toEqual(
		geometry(ref.log.filter((op) => op.c === ref.full || op.c === "tile"))
	);
	if (withTile) expect(live.log.some((op) => op.c === "tile" && op.op === "fill"), "precondition: the pen drew through the tile").toBe(true);
	const end = ribbon(live);
	expect(end, "precondition: the strip has a last point").toBeDefined();

	realloc(live);
	const after = sinceBlank(live);
	expect(live.log.some((op) => op.c === live.full && (op.op === "size" || op.op === "restored")),
		"precondition: the live layer's canvas was blanked").toBe(true);
	expect(fills(after), "the strip so far, held by the blanked layer by the next frame").toBe(fills(
		ref.log.filter((op) => op.c === ref.full || op.c === "tile")
	));
	expect(geometry(after), "the same strip an unreset stroke has").toEqual(drawn);
	expect(ribbon(live), "the ribbon's last point").toEqual(end);
	expect(live.replays(), "one replay for one reallocation").toBe(1);

	// One more move, no lift: the next piece is the unreset stroke's next piece.
	const mark = live.log.length;
	const refMark = ref.log.length;
	live.move(9, 9);
	ref.move(9, 9);
	const next = geometry(live.log.slice(mark).filter((op) => op.c === live.full || op.c === "tile"));
	expect(next, "precondition: the move drew a piece").not.toEqual([]);
	expect(next, "the next piece").toEqual(geometry(ref.log.slice(refMark).filter((op) => op.c === ref.full || op.c === "tile")));
	expect(ribbon(live), "the ribbon's last point after the next piece").toEqual(ribbon(ref));
}

describe("the stroke being drawn, across a reallocation with the pen down", () => {
	let prevTool: ReturnType<typeof getInlineTool>;
	beforeEach(() => {
		prevTool = getInlineTool();
	});
	afterEach(() => {
		setInlineTool(prevTool);
	});

	// Defect: the arm blanks the wet canvas and only schedules a repaint, which draws the tip, so the stroke so far stays
	// blank until the lift. Or a redraw that is not the strip the pen drew (a different shape or width), or one that moves the
	// ribbon's last point, so the next piece starts somewhere else.
	for (const [name, realloc] of Object.entries(REALLOCS)) {
		it(`pen through the wet tile, ${name}: by the next frame the strip so far is back, the same strip, and the next piece starts where it did`, async () => {
			// Defect, on top: a redraw into the tile that the tile's own wipe then throws away.
			await stripBack("pen", realloc, true);
		});
	}

	for (const tool of ["pen", "highlighter"] as const) {
		for (const [name, realloc] of Object.entries(REALLOCS)) {
			it(`${tool}, ${name}: by the next frame the strip so far is back, the same strip, and the next piece starts where it did`, async () => {
				await stripBack(tool, realloc, false);
			});
		}

		it(`${tool}, no reallocation: a resize at the same size and the frames after it draw the strip again 0 times`, async () => {
			// Defect: the strip is drawn again on a pass that reallocated nothing (the unchanged arm, a scheduled repaint).
			const live = await openLive(tool);
			live.move(1, 8);
			const end = ribbon(live);
			const mark = live.log.length;
			proto.handleResize!.call(live.o);
			live.rig.deliverPaintCallbacks();
			expect(live.log.slice(mark).some((op) => op.op === "size" || op.op === "restored"), "precondition: nothing was reallocated").toBe(false);
			expect(live.replays(), "replays").toBe(0);
			expect(geometry(live.log.slice(mark).filter((op) => op.c === live.full || op.c === "tile")), "strip draws").toEqual([]);
			expect(ribbon(live), "the ribbon's last point").toEqual(end);
		});
	}
});
