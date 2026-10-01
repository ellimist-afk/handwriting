/**
 * Audit probe Slides-2-1 (1.4.21 tag 1a05f62c).
 *
 * Claim: with mouse ink on, a mouse button held still is read as a silent pen
 * lift. The silence deadline (SILENT_LIFT_QUIET_MS, 300 ms) is armed for every
 * claimed contact, mouse included, and `lastPointerAt` only moves when an
 * event arrives. A still mouse sends no events, so the deadline ends the
 * stroke: a held dot is thrown away as a tap, and after a pause mid-drag the
 * rest of the same drag is dropped.
 *
 * The cells assert the CORRECT behaviour, so they go red only if the bug is
 * real. The rig below is copied from src/slides/SlidesInkSurface.test.ts
 * (FakeEl/FakeDoc/FakeWin/makeRig, trimmed); the surface under test is the
 * real production SlidesDeck.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	SILENT_LIFT_QUIET_MS,
	ScreenRect,
	SlidesDeck,
	SlidesInkHost,
	TAP_MS,
	claimsContact,
} from "../slides/SlidesInkSurface";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { setMouseInk, mouseInkEnabled } from "../inline/MouseInk";
import { PageData, ParseResult } from "../model/PageData";
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
	setMouseInk(false);
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
}

function makeRig(): Rig {
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
		loadSidecar: async (): Promise<ParseResult | null> => null,
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

describe("Slides-2-1: a still mouse button under mouse ink", () => {
	it("precondition: the rig claims a left-button mouse contact once mouse ink is on", () => {
		setMouseInk(true);
		expect(mouseInkEnabled()).toBe(true);
		expect(claimsContact("mouse", true, 1, true)).toBe(true);
		expect(SILENT_LIFT_QUIET_MS).toBe(300);
		expect(TAP_MS).toBe(250);
	});

	it("control: a mouse press held 280 ms (past TAP_MS, before the deadline fires) saves a dot", async () => {
		setMouseInk(true);
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.dispatch("pointerdown", { timeStamp: 1000 });
		expect(sessionPhase(rig)).toBe("drawing");
		expect(rig.win.pendingDelays()).not.toContain(SILENT_LIFT_QUIET_MS);
		clock.mockReturnValue(1280);
		rig.dispatch("pointerup", { buttons: 0, pressure: 0, timeStamp: 1280 });
		await new Promise((r) => setTimeout(r, 0));
		expect(lastStrokes(rig)).toHaveLength(1);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("(b) a mouse press held still for 400 ms is a deliberate dot and is saved", async () => {
		setMouseInk(true);
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.dispatch("pointerdown", { timeStamp: 1000 });
		// The contact is claimed and live. A mouse contact arms no silence
		// deadline (only a pen can go silent without a button-up).
		expect(sessionPhase(rig)).toBe("drawing");
		expect(rig.win.pendingDelays()).not.toContain(SILENT_LIFT_QUIET_MS);
		// The button stays down, the mouse does not move: a real mouse sends
		// nothing. 301 ms later the deadline fires, as it would in a browser
		// before the 400 ms release arrives.
		clock.mockReturnValue(1301);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		const silent = deckLogs.some((l) => l.includes("reason=silent-lift") || l.includes("reason=tap"));
		// Release at 400 ms, still at the same spot.
		clock.mockReturnValue(1400);
		rig.dispatch("pointerup", { buttons: 0, pressure: 0, timeStamp: 1400 });
		await new Promise((r) => setTimeout(r, 0));
		expect(
			lastStrokes(rig),
			`held mouse dot was not saved; deadline ended it early=${silent}; logs=${JSON.stringify(
				deckLogs.filter((l) => l.includes("end on slide"))
			)}`
		).toHaveLength(1);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("control: a mouse drag with no pause keeps every move in one stroke", async () => {
		setMouseInk(true);
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.dispatch("pointerdown", { clientX: 100, clientY: 100, timeStamp: 1000 });
		const pts: Array<[number, number, number]> = [
			[1016, 140, 100],
			[1032, 180, 100],
			[1048, 220, 100],
			[1064, 260, 100],
		];
		for (const [t, x, y] of pts) {
			clock.mockReturnValue(t);
			rig.dispatch("pointermove", { clientX: x, clientY: y, timeStamp: t });
		}
		clock.mockReturnValue(1080);
		rig.dispatch("pointerup", { clientX: 260, clientY: 100, buttons: 0, pressure: 0, timeStamp: 1080 });
		await new Promise((r) => setTimeout(r, 0));
		const strokes = lastStrokes(rig);
		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.some((p) => p.x === lx(220))).toBe(true);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("(a) a mouse drag that pauses 400 ms with the button held keeps inking after the pause", async () => {
		setMouseInk(true);
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.dispatch("pointerdown", { clientX: 100, clientY: 100, timeStamp: 1000 });
		clock.mockReturnValue(1016);
		rig.dispatch("pointermove", { clientX: 140, clientY: 100, timeStamp: 1016 });
		clock.mockReturnValue(1032);
		rig.dispatch("pointermove", { clientX: 180, clientY: 100, timeStamp: 1032 });
		expect(sessionPhase(rig)).toBe("drawing");
		// Pause at the corner, button still held: no events for 400 ms. The
		// deadline (re-armed for the remainder) fires inside that pause.
		clock.mockReturnValue(1432);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		const liveAfterPause = sessionPhase(rig);
		// Keep dragging down from the corner without releasing.
		clock.mockReturnValue(1448);
		rig.dispatch("pointermove", { clientX: 180, clientY: 140, timeStamp: 1448 });
		clock.mockReturnValue(1464);
		rig.dispatch("pointermove", { clientX: 180, clientY: 180, timeStamp: 1464 });
		clock.mockReturnValue(1480);
		rig.dispatch("pointermove", { clientX: 180, clientY: 220, timeStamp: 1480 });
		clock.mockReturnValue(1496);
		rig.dispatch("pointerup", { clientX: 180, clientY: 220, buttons: 0, pressure: 0, timeStamp: 1496 });
		await new Promise((r) => setTimeout(r, 0));
		const strokes = lastStrokes(rig);
		const postPause = strokes.some((s) => s.points.some((p) => p.x === lx(180) && p.y === (180 - 25) * 2));
		expect(
			postPause,
			`moves after the pause left no ink; session after pause=${liveAfterPause}; strokes=${
				strokes.length
			}; points=${JSON.stringify(strokes.map((s) => s.points.map((p) => [p.x, p.y])))}; logs=${JSON.stringify(
				deckLogs.filter((l) => l.includes("end on slide"))
			)}`
		).toBe(true);
		clock.mockRestore();
		rig.deck.dispose();
	});
});
