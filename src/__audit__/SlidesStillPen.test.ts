/**
 * A slides pen that rests still for 300 ms.
 *
 * Claim: a PEN resting still for 300 ms loses its ink in the slides surface. The silence
 * deadline (SILENT_LIFT_QUIET_MS) is armed for every pen contact and only moves when an
 * event arrives; SlidesInkSurface.ts onPointerEnd says a motionless contact produces no
 * move events. If the nib sends nothing while still, the deadline ends the contact as a
 * silent lift, commitStroke treats the unpromoted contact as a tap and drops it, and every
 * later move and the pointerup are ignored (the session is idle).
 *
 * The cells assert the CORRECT behaviour, so they go red only if the bug is real. The
 * control cells must stay green under any fix. Not checked on hardware: whether a real
 * still pen nib sends no move events. The rig is copied from Slides-2-1.test.ts (the mouse
 * version of this claim), with pen events; the surface under test is the real SlidesDeck.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	SILENT_LIFT_QUIET_MS,
	ScreenRect,
	SlidesDeck,
	SlidesInkHost,
	TAP_MS,
	sectionHash,
} from "../slides/SlidesInkSurface";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { setInkThemeOverride } from "../ink/InkTheme";

type AnyEvent = Record<string, unknown> & { type: string };

const deckLogs: string[] = [];

beforeEach(() => {
	setDiagnosticsEnabled(true);
	deckLogs.length = 0;
	vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
		deckLogs.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	setDiagnosticsEnabled(false);
	vi.restoreAllMocks();
	setInkThemeOverride(null);
});

class FakeEl {
	createEl(tag: string): FakeEl {
		const child = this.ownerDocument.createElement(tag);
		this.appendChild(child);
		return child;
	}
	createDiv(): FakeEl {
		return this.createEl("div");
	}
	readonly style: Record<string, string> = { position: "", touchAction: "" };
	readonly children: FakeEl[] = [];
	className = "";
	id = "";
	textContent = "";
	rect: ScreenRect = { left: 0, top: 0, width: 0, height: 0 };
	clientWidth = 0;
	clientHeight = 0;
	rectCalls = 0;
	backingWrites = 0;
	readonly classes = new Set<string>();
	readonly listeners: Array<{ type: string; fn: (ev: unknown) => void }> = [];
	readonly captured: number[] = [];
	readonly captureCalls: number[] = [];
	readonly classList = {
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
		contains: (c: string) => this.classes.has(c),
	};
	isContentEditable = false;
	readonly attributes = new Map<string, string>();
	private _tabIndex = -1;

	get tabIndex(): number {
		return this._tabIndex;
	}

	set tabIndex(v: number) {
		this._tabIndex = v;
		this.attributes.set("tabindex", String(v));
	}

	constructor(
		readonly tagName: string,
		readonly ownerDocument: FakeDoc
	) {}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}

	addEventListener(type: string, fn: (ev: unknown) => void): void {
		this.listeners.push({ type, fn });
	}

	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
		if (i >= 0) this.listeners.splice(i, 1);
	}

	getBoundingClientRect(): ScreenRect {
		this.rectCalls++;
		return this.rect;
	}

	appendChild(child: FakeEl): void {
		if (child.parentElement) child.remove();
		this.children.push(child);
		child.parentElement = this;
	}

	parentElement: FakeEl | null = null;

	remove(): void {
		const p = this.parentElement;
		if (p) {
			const i = p.children.indexOf(this);
			if (i >= 0) p.children.splice(i, 1);
		}
		this.parentElement = null;
	}

	contains(other: unknown): boolean {
		return other === this;
	}

	readonly focusCalls: unknown[] = [];

	focus(options?: unknown): void {
		this.focusCalls.push(options);
		if (this.attributes.has("tabindex")) this.ownerDocument.activeElement = this;
	}

	blur(): void {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
	}

	setPointerCapture(id: number): void {
		this.captured.push(id);
		this.captureCalls.push(id);
	}

	releasePointerCapture(id: number): void {
		const i = this.captured.indexOf(id);
		if (i >= 0) this.captured.splice(i, 1);
	}

	dispatch(ev: AnyEvent): void {
		for (const l of this.listeners.slice()) if (l.type === ev.type) l.fn(ev);
	}
}

interface ClearCounts {
	clears: number;
	rects: Array<{ el: FakeEl; x: number; y: number; w: number; h: number }>;
}

function fakeCtx(counts: ClearCounts, granted: () => boolean, el: FakeEl): CanvasRenderingContext2D {
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "clearRect")
					return (x: number, y: number, w: number, h: number) => {
						counts.clears++;
						counts.rects.push({ el, x, y, w, h });
					};
				if (prop === "getContextAttributes") return () => ({ desynchronized: granted() });
				return () => undefined;
			},
			set: () => true,
		}
	) as unknown as CanvasRenderingContext2D;
}

class FakeDoc {
	refusedContextClass: string | undefined;
	activeElement: unknown = null;
	readonly clearCounts: ClearCounts = { clears: 0, rects: [] };
	grantedDesynchronized = false;
	defaultView!: FakeWin;
	head: { querySelector: (selectors: string) => unknown } | undefined;

	createElement(tag: string): FakeEl {
		const el = new FakeEl(tag, this);
		const counts = this.clearCounts;
		const doc = this;
		const canvas = el as unknown as {
			getContext: () => CanvasRenderingContext2D | null;
			width: number;
			height: number;
		};
		canvas.getContext = () =>
			el.className === doc.refusedContextClass ? null : fakeCtx(counts, () => doc.grantedDesynchronized, el);
		let w = 0;
		let h = 0;
		Object.defineProperty(el, "width", {
			configurable: true,
			get: () => w,
			set: (v: number) => {
				w = v;
				el.backingWrites++;
			},
		});
		Object.defineProperty(el, "height", {
			configurable: true,
			get: () => h,
			set: (v: number) => {
				h = v;
				el.backingWrites++;
			},
		});
		canvas.width = 0;
		canvas.height = 0;
		el.backingWrites = 0;
		return el;
	}
}

class FakeWin {
	devicePixelRatio = 1;
	computedPosition = "static";
	navigator: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined = undefined;
	computedBackground: unknown = undefined;
	readonly timers = new Map<number, { fn: () => void; delay: number }>();
	readonly frames = new Map<number, () => void>();
	private nextTimer = 1;
	private nextFrame = 1;

	setTimeout(fn: () => void, delay = 0): number {
		const id = this.nextTimer++;
		this.timers.set(id, { fn, delay });
		return id;
	}

	clearTimeout(id: number): void {
		this.timers.delete(id);
	}

	requestAnimationFrame(fn: () => void): number {
		const id = this.nextFrame++;
		this.frames.set(id, fn);
		return id;
	}

	cancelAnimationFrame(id: number): void {
		this.frames.delete(id);
	}

	getComputedStyle(): { position: string; backgroundColor: unknown } {
		return { position: this.computedPosition, backgroundColor: this.computedBackground };
	}

	readonly mediaQueries: Array<{ query: string; listeners: Array<() => void> }> = [];

	matchMedia(query: string): MediaQueryList {
		const entry = { query, listeners: [] as Array<() => void> };
		this.mediaQueries.push(entry);
		return {
			media: query,
			matches: true,
			addEventListener: (_type: string, fn: () => void) => void entry.listeners.push(fn),
			removeEventListener: (_type: string, fn: () => void) => {
				const i = entry.listeners.indexOf(fn);
				if (i >= 0) entry.listeners.splice(i, 1);
			},
		} as unknown as MediaQueryList;
	}

	addEventListener(): void {
		/* never fired here */
	}

	removeEventListener(): void {
		/* ditto */
	}

	readonly MutationObserver = class {
		observe(): void {
			/* not driven */
		}
		disconnect(): void {
			/* nothing */
		}
	};

	/** Pending timers with their delays, for the precondition asserts. */
	pendingDelays(): number[] {
		return [...this.timers.values()].map((t) => t.delay);
	}

	runTimers(maxDelay = Number.POSITIVE_INFINITY): void {
		for (const [id, t] of [...this.timers].sort((a, b) => a[0] - b[0])) {
			if (t.delay > maxDelay) continue;
			this.timers.delete(id);
			t.fn();
		}
	}
}

interface Rig {
	deck: SlidesDeck;
	win: FakeWin;
	scheduled: Array<{ id: string; page: PageData }>;
	savedNow: Array<{ id: string; page: PageData }>;
	dispatch(type: string, over?: Partial<AnyEvent>): void;
	/** A click on the deck (Reveal's navigation click): `stopped` is whether the guard swallowed it. */
	click(): { stopped: boolean };
	/** Reveal moves to another slide: the `present` class moves and `slidechanged` fires. */
	navigate(index: number): void;
}

function makeRig(opts: { load?: () => Promise<ParseResult | null> } = {}): Rig {
	const doc = new FakeDoc();
	const win = new FakeWin();
	doc.defaultView = win;
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	// A 960x700 deck drawn at half scale: k = 0.5.
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	for (let i = 0; i < 2; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	const scheduled: Array<{ id: string; page: PageData }> = [];
	const savedNow: Array<{ id: string; page: PageData }> = [];
	const source = ["slide 0", "slide 1"].join("\n\n---\n\n");
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: async () => source,
		readPageId: () => "note-1",
		claimId: async (_path, proposed) => ({ pageId: proposed }),
		newPageId: () => "note-1",
		loadSidecar: opts.load ?? (async (): Promise<ParseResult | null> => null),
		scheduleSidecar: (id, page) => void scheduled.push({ id, page }),
		saveSidecarNow: async (id, page) => {
			savedNow.push({ id, page });
		},
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "test-build",
	};
	const deck = new SlidesDeck(
		container as unknown as HTMLElement,
		reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement,
		host
	);
	const ev = (type: string, over: Partial<AnyEvent> = {}): AnyEvent => ({
		type,
		pointerId: 1,
		pointerType: "mouse",
		isPrimary: true,
		buttons: 1,
		button: 0,
		clientX: 200,
		clientY: 200,
		pressure: 0.5,
		timeStamp: 0,
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
		...over,
	});
	return {
		deck,
		win,
		scheduled,
		savedNow,
		dispatch: (type, over) => reveal.dispatch(ev(type, over)),
		click: () => {
			const seen = { stopped: false };
			reveal.dispatch(ev("click", { stopPropagation: () => void (seen.stopped = true) }));
			return seen;
		},
		navigate: (index) => {
			slides.children.forEach((s, i) => (i === index ? s.classes.add("present") : s.classes.delete("present")));
			reveal.dispatch({ type: "slidechanged" });
		},
	};
}

function allPages(rig: Rig): PageData[] {
	return [...rig.scheduled, ...rig.savedNow].map((w) => w.page);
}

function lastStrokes(rig: Rig): PageData["strokes"] {
	const pages = allPages(rig);
	return pages.length ? pages[pages.length - 1]!.strokes : [];
}

function sessionPhase(rig: Rig): string {
	return (rig.deck as unknown as { session: { phase: string } }).session.phase;
}

/** Screen x -> deck-logical x at the rig's k = 0.5 (slides.left = 20). */
const lx = (screenX: number): number => (screenX - 20) * 2;

/**
 * The rig's screen is whole-pixel and every move is a whole number of device
 * px, so the pen's coarse-grid smoothing is on: after a stroke's first sample,
 * each stored point is the mean of its sample and the one before, and the lift
 * stores the last sample as itself. `mid(a, b)` is that mean in deck-logical x.
 */
const mid = (a: number, b: number): number => (lx(a) + lx(b)) / 2;

/** A pen contact on the rig: the pen sends `pen` events with pressure and the tip button. */
const pen = (over: Partial<AnyEvent> = {}): Partial<AnyEvent> => ({ pointerType: "pen", buttons: 1, pressure: 0.5, ...over });

async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

/** Every point x (deck-logical) of every stroke in the last save. */
function savedXs(rig: Rig): number[] {
	return lastStrokes(rig).flatMap((s) => s.points.map((p) => p.x));
}

describe("slides pen at rest: the 300 ms silence deadline under a pen that sends nothing while still", () => {
	it("precondition: a pen contact arms the silence deadline and TAP_MS is shorter than it", async () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await settle();
		rig.dispatch("pointerdown", pen({ timeStamp: 1000 }));
		expect(sessionPhase(rig)).toBe("drawing");
		expect(rig.win.pendingDelays(), "a pen arms the quiet timer").toContain(SILENT_LIFT_QUIET_MS);
		expect(TAP_MS).toBeLessThan(SILENT_LIFT_QUIET_MS);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("control: a pen that keeps moving keeps every sample in one stroke", async () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await settle();
		rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		for (const [t, x] of [
			[1016, 140],
			[1032, 180],
			[1048, 220],
			[1064, 260],
		] as const) {
			clock.mockReturnValue(t);
			rig.dispatch("pointermove", pen({ clientX: x, clientY: 100, timeStamp: t }));
		}
		clock.mockReturnValue(1080);
		rig.dispatch("pointerup", pen({ clientX: 260, clientY: 100, buttons: 0, pressure: 0, timeStamp: 1080 }));
		await settle();
		expect(lastStrokes(rig)).toHaveLength(1);
		expect(savedXs(rig), "lift point stored: on a whole-pixel grid each point is the mean of its sample and the one before, and the lift stores the last sample as itself").toEqual([lx(100), mid(100, 140), mid(140, 180), mid(180, 220), mid(220, 260), lx(260)]);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("(a) a pen held still for 400 ms and then lifted with its pointerup leaves a dot", async () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await settle();
		rig.dispatch("pointerdown", pen({ timeStamp: 1000 }));
		// No events while the nib rests: the deadline fires at 300 ms.
		clock.mockReturnValue(1301);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		clock.mockReturnValue(1400);
		rig.dispatch("pointerup", pen({ buttons: 0, pressure: 0, timeStamp: 1400 }));
		await settle();
		expect(
			lastStrokes(rig),
			`the held dot was lost; logs=${JSON.stringify(deckLogs.filter((l) => l.includes("end on slide")))}`
		).toHaveLength(1);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("(b) a stroke that starts with a 400 ms rest draws the writing that follows", async () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await settle();
		rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		clock.mockReturnValue(1301);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		for (const [t, x] of [
			[1416, 140],
			[1432, 180],
			[1448, 220],
		] as const) {
			clock.mockReturnValue(t);
			rig.dispatch("pointermove", pen({ clientX: x, clientY: 100, timeStamp: t }));
		}
		clock.mockReturnValue(1464);
		rig.dispatch("pointerup", pen({ clientX: 220, clientY: 100, buttons: 0, pressure: 0, timeStamp: 1464 }));
		await settle();
		expect(savedXs(rig), "no ink after the opening rest; " + "lift point stored: on a whole-pixel grid each point is the mean of its sample and the one before, and the lift stores the last sample as itself").toEqual([lx(140), mid(140, 180), mid(180, 220), lx(220)]);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("(c) a pause of 400 ms in the middle of a stroke keeps the writing after the pause", async () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await settle();
		rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		for (const [t, x] of [
			[1016, 140],
			[1032, 180],
		] as const) {
			clock.mockReturnValue(t);
			rig.dispatch("pointermove", pen({ clientX: x, clientY: 100, timeStamp: t }));
		}
		expect(sessionPhase(rig)).toBe("drawing");
		// The nib rests at the corner: nothing arrives for 400 ms, the deadline fires inside the pause.
		clock.mockReturnValue(1332);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		const phaseAfterPause = sessionPhase(rig);
		for (const [t, y] of [
			[1448, 140],
			[1464, 180],
			[1480, 220],
		] as const) {
			clock.mockReturnValue(t);
			rig.dispatch("pointermove", pen({ clientX: 180, clientY: y, timeStamp: t }));
		}
		clock.mockReturnValue(1496);
		rig.dispatch("pointerup", pen({ clientX: 180, clientY: 220, buttons: 0, pressure: 0, timeStamp: 1496 }));
		await settle();
		const ys = lastStrokes(rig).flatMap((s) => s.points.map((p) => p.y));
		expect(
			ys.some((y) => y > 150),
			`nothing after the pause was saved; phase after the pause = ${phaseAfterPause}`
		).toBe(true);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("control: a pen that stops sending and never lifts is ended by the deadline, so a real silent lift still commits", async () => {
		// The deadline exists for a pen that left the glass with no pointerup. The fix for the cells above must keep this.
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await settle();
		rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		for (const [t, x] of [
			[1016, 140],
			[1032, 180],
			[1048, 220],
		] as const) {
			clock.mockReturnValue(t);
			rig.dispatch("pointermove", pen({ clientX: x, clientY: 100, timeStamp: t }));
		}
		clock.mockReturnValue(1400);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		await settle();
		expect(sessionPhase(rig), "the deadline ended the contact").not.toBe("drawing");
		expect(savedXs(rig), "the writing before the silence is saved; " + "lift point stored: on a whole-pixel grid each point is the mean of its sample and the one before, and the lift stores the last sample as itself").toEqual([lx(100), mid(100, 140), mid(140, 180), mid(180, 220), lx(220)]);
		clock.mockRestore();
		rig.deck.dispose();
	});
});

/** Screen y -> deck-logical y at the rig's k = 0.5 (slides.top = 25). */
const ly = (screenY: number): number => (screenY - 25) * 2;

/** How many undo steps the deck holds: undoes until there is nothing left to undo. */
function undoSteps(rig: Rig): number {
	let n = 0;
	while (rig.deck.run("undo")) n++;
	return n;
}

/** Every saved stroke as its list of [x, y] in deck-logical units, in saved order. */
function savedPoints(rig: Rig): Array<Array<[number, number]>> {
	return lastStrokes(rig).map((s) => s.points.map((p): [number, number] => [p.x, p.y]));
}

describe("slides pen rest: a later sample from the same contact writes again", () => {
	/** A rig on a mocked clock; `done` puts both back. */
	async function start(load?: () => Promise<ParseResult | null>) {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig(load ? { load } : {});
		await settle();
		const at = (t: number): void => void clock.mockReturnValue(t);
		const move = (t: number, x: number, y: number, over: Partial<AnyEvent> = {}): void => {
			at(t);
			rig.dispatch("pointermove", pen({ clientX: x, clientY: y, timeStamp: t, ...over }));
		};
		const up = (t: number, x: number, y: number, over: Partial<AnyEvent> = {}): void => {
			at(t);
			rig.dispatch("pointerup", pen({ clientX: x, clientY: y, buttons: 0, pressure: 0, timeStamp: t, ...over }));
		};
		/** The deadline: the clock is past the quiet window and the timers run (twice: the guard's own drop is armed by the first). */
		const rest = (t: number): void => {
			at(t);
			rig.win.runTimers(SILENT_LIFT_QUIET_MS);
			rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		};
		const done = (): void => {
			clock.mockRestore();
			rig.deck.dispose();
		};
		return { rig, at, move, up, rest, done };
	}

	/** Down at (100,100), then two samples out to (180,100): the opening stroke of most cells. */
	function opening(r: Awaited<ReturnType<typeof start>>): void {
		r.rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		r.move(1016, 140, 100);
		r.move(1032, 180, 100);
	}

	it("a rest, then a hover sample, then moves: no new ink", async () => {
		const r = await start();
		opening(r);
		r.rest(1332);
		expect(lastStrokes(r.rig), "the opening stroke is saved at the deadline").toHaveLength(1);
		r.move(1400, 220, 100, { buttons: 0, pressure: 0 });
		r.move(1416, 260, 100);
		r.move(1432, 300, 100);
		r.up(1448, 300, 100);
		await settle();
		expect(lastStrokes(r.rig)).toHaveLength(1);
		// A range, not an exact x: smoothing stores means, so an exact value can be
		// absent while the ink it guards is there. The opening stroke ends at
		// lx(180); anything right of it came after the hover.
		expect(Math.max(...savedXs(r.rig)), "nothing after the hover is ink").toBeLessThanOrEqual(lx(180));
		r.done();
	});

	it("a drawn stroke, a rest, then pointerup with no move: no second stroke, and the lift presses no arrow", async () => {
		const r = await start();
		opening(r);
		r.rest(1332);
		r.up(1400, 180, 100);
		const click = r.rig.click();
		await settle();
		expect(lastStrokes(r.rig), "no second stroke from the lift").toHaveLength(1);
		expect(savedPoints(r.rig)[0]!.map(([x]) => x), "lift point stored: on a whole-pixel grid each point is the mean of its sample and the one before, and the lift stores the last sample as itself").toEqual([lx(100), mid(100, 140), mid(140, 180), lx(180)]);
		expect(undoSteps(r.rig)).toBe(1);
		expect(click.stopped, "the lift of a stroke that was drawn must not click the arrow under the nib").toBe(true);
		r.done();
	});

	it("a held dot lifted over a slide arrow: one dot, no navigation", async () => {
		const r = await start();
		r.rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		r.rest(1332);
		expect(lastStrokes(r.rig), "nothing is saved at the deadline for a held dot").toHaveLength(0);
		r.up(1400, 100, 100);
		const click = r.rig.click();
		await settle();
		// The builder gives a held dot its usual nudged second point, so the dot is checked as one stroke whose points all sit at the point held.
		const dot = savedPoints(r.rig);
		expect(dot, "one dot").toHaveLength(1);
		expect(dot[0]!.length).toBeGreaterThan(0);
		for (const [x, y] of dot[0]!) {
			expect(Math.abs(x - lx(100)), "the dot sits at the point held").toBeLessThan(0.05);
			expect(y).toBe(ly(100));
		}
		expect(undoSteps(r.rig)).toBe(1);
		expect(click.stopped, "the dot's own click must not turn the slide").toBe(true);
		r.done();
	});

	it("a rest, then a new pen pointerdown: the old contact writes nothing more", async () => {
		const r = await start();
		opening(r);
		r.rest(1332);
		r.at(1400);
		r.rig.dispatch("pointerdown", pen({ pointerId: 2, clientX: 400, clientY: 300, timeStamp: 1400 }));
		r.move(1416, 440, 300, { pointerId: 2 });
		r.up(1432, 440, 300, { pointerId: 2 });
		// The first contact's pointer speaks again, long after the new contact is done.
		r.move(1448, 500, 300);
		r.move(1464, 540, 300);
		r.up(1480, 540, 300);
		await settle();
		expect(lastStrokes(r.rig)).toHaveLength(2);
		// A range, not exact xs: smoothing stores means. The new contact ends at
		// lx(440); the old contact's samples are all right of it.
		expect(Math.max(...savedXs(r.rig)), "the old contact adds nothing").toBeLessThanOrEqual(lx(440));
		r.done();
	});

	it("a rest, a palm touch, then moves: the writing is saved", async () => {
		const r = await start();
		opening(r);
		r.rest(1332);
		r.at(1400);
		r.rig.dispatch("pointerdown", { pointerId: 9, pointerType: "touch", buttons: 1, pressure: 0.5, clientX: 60, clientY: 300, timeStamp: 1400 });
		r.rig.dispatch("pointerup", { pointerId: 9, pointerType: "touch", buttons: 0, pressure: 0, clientX: 60, clientY: 300, timeStamp: 1408 });
		r.move(1416, 220, 100);
		r.move(1432, 260, 100);
		r.up(1448, 260, 100);
		await settle();
		expect(lastStrokes(r.rig), "the writing after the palm touch is a second stroke").toHaveLength(2);
		expect(savedPoints(r.rig)[1]!.map(([x]) => x), "lift point stored: on a whole-pixel grid each point is the mean of its sample and the one before, and the lift stores the last sample as itself").toEqual([lx(220), mid(220, 260), lx(260)]);
		r.done();
	});

	it("a rest across a slide change: nothing on the new slide", async () => {
		const r = await start();
		opening(r);
		r.rest(1332);
		r.rig.navigate(1);
		r.move(1416, 220, 100);
		r.move(1432, 260, 100);
		r.up(1448, 260, 100);
		await settle();
		expect(lastStrokes(r.rig)).toHaveLength(1);
		expect(lastStrokes(r.rig)[0]!.page, "the one stroke belongs to the slide it was drawn on").toBe(1);
		r.done();
	});

	it("two rests in one contact: three strokes, every drawn sample saved once", async () => {
		const r = await start();
		opening(r);
		r.rest(1332);
		r.move(1448, 180, 140);
		r.move(1464, 180, 180);
		r.rest(1765);
		r.move(1800, 220, 180);
		r.move(1816, 260, 180);
		r.up(1832, 260, 180);
		await settle();
		// Each stroke after a rest starts as given, then means, then its own
		// last sample again at its end.
		const midY = (a: number, b: number): number => (ly(a) + ly(b)) / 2;
		expect(savedPoints(r.rig), "lift point stored: on a whole-pixel grid each point is the mean of its sample and the one before, and the lift stores the last sample as itself").toEqual([
			[[lx(100), ly(100)], [mid(100, 140), ly(100)], [mid(140, 180), ly(100)], [lx(180), ly(100)]],
			[[lx(180), ly(140)], [lx(180), midY(140, 180)], [lx(180), ly(180)]],
			[[lx(220), ly(180)], [mid(220, 260), ly(180)], [lx(260), ly(180)]],
		]);
		expect(undoSteps(r.rig), "three strokes, three undo steps").toBe(3);
		r.done();
	});

	it("an eraser contact that rests keeps erasing and never inks", async () => {
		const stored = (id: string, x: number, y: number) => ({
			id,
			tool: "pen" as const,
			color: "#000",
			width: 2,
			page: 1,
			points: [{ x, y, pressure: 0.5, t: 0 }],
			bbox: { x, y, width: 0, height: 0 },
			createdAt: 0,
		});
		const r = await start(async () => ({
			data: {
				...emptyPage("note-1.slides"),
				surface: "slides",
				coordSpace: "slide-logical",
				slides: [
					{ index: 0, hash: sectionHash("slide 0") },
					{ index: 1, hash: sectionHash("slide 1") },
				],
				strokes: [stored("old-a", lx(120), ly(125)), stored("old-b", lx(320), ly(125))],
			},
			recovered: false,
		}));
		const eraser = (over: Partial<AnyEvent> = {}): Partial<AnyEvent> => pen({ buttons: 32, ...over });
		r.rig.dispatch("pointerdown", eraser({ clientX: 100, clientY: 125, timeStamp: 1000 }));
		r.at(1016);
		r.rig.dispatch("pointermove", eraser({ clientX: 120, clientY: 125, timeStamp: 1016 }));
		r.rest(1332);
		expect(lastStrokes(r.rig).map((s) => s.id), "the first stroke was erased before the rest").toEqual(["old-b"]);
		r.at(1416);
		r.rig.dispatch("pointermove", eraser({ clientX: 320, clientY: 125, timeStamp: 1416 }));
		r.at(1432);
		r.rig.dispatch("pointerup", eraser({ clientX: 320, clientY: 125, buttons: 0, pressure: 0, timeStamp: 1432 }));
		await settle();
		expect(lastStrokes(r.rig), "the erase carried on after the rest and nothing was inked").toEqual([]);
		expect(undoSteps(r.rig), "two erase gestures, two undo steps").toBe(2);
		r.done();
	});

	it("a quick pen tap on an arrow still navigates", async () => {
		const r = await start();
		r.rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		r.up(1050, 100, 100);
		r.rig.win.runTimers(0);
		expect(r.rig.click().stopped, "a tap never became ink, so its click reaches the arrow").toBe(false);
		await settle();
		expect(lastStrokes(r.rig)).toHaveLength(0);
		r.done();
	});

	it("a contact silent to the end saves no dot", async () => {
		const r = await start();
		r.rig.dispatch("pointerdown", pen({ clientX: 100, clientY: 100, timeStamp: 1000 }));
		r.rest(1332);
		r.rest(1700);
		await settle();
		expect(allPages(r.rig).flatMap((p) => p.strokes), "no pointerup ever came: no dot").toEqual([]);
		r.done();
	});
});
