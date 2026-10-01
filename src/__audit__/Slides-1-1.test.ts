/**
 * Audit probe Slides-1-1 (verifier, lens EXECUTION).
 *
 * Claim: the note check (noteMatchesDeck / normaliseSectionText) refuses a deck
 * whose first slide carries common Markdown the presenter renders differently
 * from its source (inline code, image alt text, aliased wikilinks, sized
 * embeds, checked tasks), so the whole presentation goes memory-only: the
 * saved sidecar is never loaded and new strokes are never saved.
 *
 * Drives the REAL SlidesDeck through the same fake-DOM rig the module's own
 * suite uses (copied verbatim from src/slides/SlidesInkSurface.test.ts lines
 * 1003-1624). Each case feeds the note source and the section textContent a
 * Markdown renderer produces for it (<code> keeps its text, <img> and a
 * checkbox <input> contribute none, an aliased internal link shows only its
 * alias). Asserts the CORRECT behaviour: the matching note is accepted, its
 * sidecar is loaded, a stroke is scheduled for saving and no "not being
 * saved" notice appears. A control case with plain text proves the rig is live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ScreenRect,
	SlidesDeck,
	SlidesInkHost,
	noteMatchesDeck,
	splitSlideSections,
} from "../slides/SlidesInkSurface";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { PageData, ParseResult } from "../model/PageData";
import { setInkThemeOverride } from "../ink/InkTheme";

const TEST_BUILD_ID = "test-build";

type AnyEvent = Record<string, unknown> & { type: string };

/**
 * `[slides]` log lines, captured for the tests that assert on one and to keep
 * the suite's output readable. File-level, so it covers every deck built below.
 */
const deckLogs: string[] = [];

beforeEach(() => {
	setDiagnosticsEnabled(false);
	deckLogs.length = 0;
	vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
		deckLogs.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	setDiagnosticsEnabled(false);
	vi.restoreAllMocks();
	// The deck theme override is module-wide state in InkTheme, set at mount.
	// A rig that was never disposed would otherwise hand its deck's reading to
	// the next test in the file.
	setInkThemeOverride(null);
});

class FakeEl {
	createEl(tag: string): FakeEl {
		const child = this.ownerDocument.createElement(tag);
		this.appendChild(child);
		return child;
	}
	/** Obsidian gives every element this shorthand; the deck now uses it. */
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
	/** Every `getBoundingClientRect` on this element, for the hot-path count. */
	rectCalls = 0;
	/** Every write to `width`/`height` once this element is a canvas (see `FakeDoc.createElement`). */
	backingWrites = 0;
	readonly classes = new Set<string>();
	readonly listeners: Array<{ type: string; fn: (ev: unknown) => void }> = [];
	readonly captured: number[] = [];
	/**
	 * Every `setPointerCapture` call, in order and never removed - `captured`
	 * is the live set, so it cannot answer "how many times, and when".
	 */
	readonly captureCalls: number[] = [];
	readonly classList = {
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
		contains: (c: string) => this.classes.has(c),
	};
	/** A CodeMirror `.cm-content` would set this; a plain `<div>` never does. */
	isContentEditable = false;
	/** Content attributes, `tabindex` included - a real element's, not the IDL default. */
	readonly attributes = new Map<string, string>();
	private _tabIndex = -1;

	/**
	 * Reflects the `tabindex` content attribute, the way a real element does:
	 * reading it never implies focusability (a bare `<div>` answers -1 too),
	 * but WRITING it is what a real `.focus()` call needs to have happened
	 * first - the exact silent no-op the source's mount-time patch exists to
	 * close.
	 */
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

	/**
	 * Real parentage, because the surface now decides whether to re-mount by
	 * comparing `canvas.parentElement` to `.reveal`. A fake that left this
	 * undefined would answer "detached" for canvases it had just mounted.
	 */
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

	/**
	 * Every `focus()` call's options argument, in order (F11). A real deck
	 * focus is `focus({ preventScroll: true })`, and a bare `focus()` scrolls
	 * the presentation - so the ARGUMENT is the protection and a fake that
	 * dropped it could not tell the two apart.
	 */
	readonly focusCalls: unknown[] = [];

	focus(options?: unknown): void {
		this.focusCalls.push(options);
		// A real `<div>` only takes DOM focus once a `tabindex` attribute has
		// made it focusable - without one, `.focus()` is a silent no-op and
		// `document.activeElement` does not move. Mirroring that here is what
		// makes the mount-time and stroke-end tests prove the patch, not just
		// the absence of a thrown error.
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

	/** Deliver an event to every listener for its type, in registration order. */
	dispatch(ev: AnyEvent): void {
		for (const l of this.listeners.slice()) if (l.type === ev.type) l.fn(ev);
	}
}

/**
 * A no-op 2d context that counts the calls the assertions care about.
 *
 * `granted` is a function rather than a constant (F4): what the browser GRANTS
 * for `desynchronized` is independent of what was requested - that difference
 * is the whole reason the mount line prints both - so the fake has to be able
 * to say "you asked for false and got true" rather than echoing the request.
 */
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

/**
 * Every `clearRect` any of this document's canvases took, in order, WITH the
 * canvas it landed on and the box it damaged.
 *
 * `clears` alone answers "how many"; two of this file's rules are about which
 * canvas and how big - the e-ink pen-up clears the stroke's own box rather
 * than the whole viewport (GAP 8), and the transient layers are cleared before
 * the committed flatten and not after (GAP 11) - and neither is visible in a
 * counter.
 */
interface ClearCounts {
	clears: number;
	rects: Array<{ el: FakeEl; x: number; y: number; w: number; h: number }>;
}

class FakeDoc {
	refusedContextClass: string | undefined;
	activeElement: unknown = null;
	readonly clearCounts: ClearCounts = { clears: 0, rects: [] };
	/** What `getContextAttributes().desynchronized` answers on this document's canvases (F4). */
	grantedDesynchronized = false;
	defaultView!: FakeWin;
	/**
	 * The presenter's stylesheet link, when a test hangs one here. Absent by
	 * default: a fake that always answered would hide which fallback ran.
	 */
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
		canvas.getContext = () => el.className === doc.refusedContextClass ? null : fakeCtx(counts, () => doc.grantedDesynchronized, el);
		// Accessors rather than plain fields, so that "was the backing store
		// REALLOCATED" is answerable (F2/item 2). A plain assignment of the
		// same number is invisible to a reader that only sees the value, and
		// reallocation - not the value - is what throws the pixels away.
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
	/**
	 * What `palmRadiusTrustworthy` is asked about. Absent by default, which is
	 * the "cannot say what platform this is" case the shape rule fails CLOSED
	 * on - so every test written before the palm shield existed keeps running
	 * with no shield attached and asserting exactly what it always did.
	 */
	navigator: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined =
		undefined;
	/**
	 * What `getComputedStyle(.reveal).backgroundColor` answers. `undefined` by
	 * default, which is what a host with no real CSS engine would give and is
	 * exactly the "cannot be measured" case the fallbacks exist for.
	 */
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

	/**
	 * Every `(resolution: Ndppx)` query the surface has ever armed, in order,
	 * each with its own live listener list. The suite runs on node with no
	 * jsdom, so there is no real `matchMedia`; a counter alone would not do,
	 * because the whole rule is that the watcher RE-ARMS on the new ratio and
	 * lets the old query go.
	 */
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

	/** Listeners still attached anywhere. Teardown has to take these to zero. */
	resolutionListenerCount(): number {
		return this.mediaQueries.reduce((n, q) => n + q.listeners.length, 0);
	}

	/**
	 * The display changed under the window: the ratio moves and every query
	 * live at this instant flips. Both lists are snapshotted first - the
	 * handler re-arms, which pushes a new query and removes its own listener,
	 * and iterating the live arrays would fire the replacement forever.
	 */
	changeResolution(dpr: number): void {
		this.devicePixelRatio = dpr;
		for (const q of [...this.mediaQueries]) for (const fn of [...q.listeners]) fn();
	}

	addEventListener(): void {
		/* the window resize listener is never fired here */
	}

	removeEventListener(): void {
		/* ditto */
	}

	readonly MutationObserver = class {
		observe(): void {
			/* the class observer is driven through the deck's own paths */
		}
		disconnect(): void {
			/* nothing to disconnect */
		}
	};

	/**
	 * Run the pending timers due within `maxDelay`, once, in id order.
	 *
	 * The delay is honoured rather than ignored because the guard's whole rule
	 * is a difference between a 0 ms release and a 300 ms tail, and a fake that
	 * fired both together could not tell the fix from the bug.
	 */
	runTimers(maxDelay = Number.POSITIVE_INFINITY): void {
		for (const [id, t] of [...this.timers].sort((a, b) => a[0] - b[0])) {
			if (t.delay > maxDelay) continue;
			this.timers.delete(id);
			t.fn();
		}
	}

	/** Run every pending animation frame once, in id order. */
	runFrames(): void {
		for (const [id, fn] of [...this.frames].sort((a, b) => a[0] - b[0])) {
			this.frames.delete(id);
			fn();
		}
	}
}

interface Rig {
	deck: SlidesDeck;
	reveal: FakeEl;
	slides: FakeEl;
	win: FakeWin;
	doc: FakeDoc;
	scheduled: Array<{ id: string; page: PageData }>;
	savedNow: Array<{ id: string; page: PageData }>;
	/** Every `claimId` call: a Markdown write on the note, the one to watch. */
	claims: string[];
	/** Every `loadSidecar` call, by id and in order - the adopt-merge's own witness (F1). */
	loads: string[];
	/** Every Notice the surface raised, in order. */
	notices: string[];
	logs: string[];
	/** How many times the surface asked the host for the eraser's whole/partial setting. */
	wholeReads(): number;
	down(over?: Partial<AnyEvent>): void;
	move(x: number, y: number, over?: Partial<AnyEvent>): void;
	/**
	 * One `pointermove` carrying N coalesced samples (F3), the way Chromium
	 * delivers a pen faster than the frame rate. The rig's ordinary `move`
	 * never carries them, so a surface that read only the last one looked
	 * identical to one that read them all.
	 */
	moveCoalesced(points: Array<{ x: number; y: number }>, over?: Partial<AnyEvent>): void;
	end(type: string, over?: Partial<AnyEvent>): void;
	click(): { stopped: boolean };
}

interface RigOptions {
	sections?: number;
	source?: string | null;
	pageId?: string | null;
	/**
	 * The host's `loadSidecar`. Takes the id now (F1): the claim-identity rule
	 * turns on WHICH sidecar is read, and a loader that could not see the id
	 * could not tell the adopted one from the proposed one.
	 */
	load?: (sidecarId: string) => Promise<ParseResult | null>;
	/** `devicePixelRatio` on the DECK's window, set before the deck is built (F2). */
	devicePixelRatio?: number;
	/** What the canvases' `getContextAttributes()` GRANTS for `desynchronized` (F4). */
	grantedDesynchronized?: boolean;
	refusedContextClass?: string;
	/** The host's `claimId`, when a test needs to hold the claim open. */
	claim?: (path: string, proposed: string) => Promise<{ pageId: string; futureVersion?: number }>;
	/** The host's immediate writer, when a test needs a real rejection. */
	saveNow?: (sidecarId: string, page: PageData) => Promise<void>;
	sectionText?: (i: number) => string;
	/** The inline `position` already on `.reveal` before the surface mounts. */
	revealPosition?: string;
	/** A `tabindex` already on `.reveal` before the surface mounts, if any. */
	revealTabIndex?: number;
	/**
	 * The note surface's eraser setting, as the host reports it. Defaults to
	 * whole-stroke, which is the plugin's own default (`eraserMode ===
	 * "stroke"`), so every test written before partial erase existed keeps
	 * asserting exactly what it always did.
	 */
	eraseWhole?: boolean;
	/** `getComputedStyle(.reveal).backgroundColor` for the deck-theme measurement. */
	deckBackground?: unknown;
	/** Which presenter stylesheet is linked in `document.head`, if any. */
	deckStylesheet?: "black" | "white";
	/** Whether the workspace body carries `theme-dark`, for the last fallback. */
	bodyDark?: boolean;
	/** The platform the palm shield's radius gate is asked about, if any. */
	navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number };
}

function makeRig(opts: RigOptions = {}): Rig {
	const doc = new FakeDoc();
	const win = new FakeWin();
	doc.defaultView = win;
	// Set before the deck is built: the surface measures the deck's theme once,
	// inside the constructor's first mount, and arms the palm shield there too.
	win.computedBackground = opts.deckBackground;
	win.navigator = opts.navigator;
	if (opts.devicePixelRatio !== undefined) win.devicePixelRatio = opts.devicePixelRatio;
	if (opts.grantedDesynchronized !== undefined) doc.grantedDesynchronized = opts.grantedDesynchronized;
	doc.refusedContextClass = opts.refusedContextClass;
	if (opts.deckStylesheet !== undefined) {
		const href = `app://obsidian.md/lib/reveal/${opts.deckStylesheet}.css`;
		doc.head = {
			querySelector: (sel: string) => {
				// Only the two selectors the surface actually asks for, matched
				// the way `[href*=...]` matches: a fake that answered any
				// selector with a hit could not tell black from white.
				const m = /^link\[href\*="([^"]+)"\]$/.exec(sel);
				return m && href.includes(m[1]!) ? { href } : null;
			},
		};
	}
	if (opts.bodyDark !== undefined) {
		const dark = opts.bodyDark;
		(doc as unknown as { body: unknown }).body = {
			classList: { contains: (c: string) => dark && c === "theme-dark" },
		};
	}
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	if (opts.revealPosition !== undefined) reveal.style.position = opts.revealPosition;
	if (opts.revealTabIndex !== undefined) reveal.tabIndex = opts.revealTabIndex;
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	// A 960x700 deck drawn at half scale: k = 0.5.
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	const n = opts.sections ?? 2;
	for (let i = 0; i < n; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = opts.sectionText ? opts.sectionText(i) : `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	const scheduled: Array<{ id: string; page: PageData }> = [];
	const savedNow: Array<{ id: string; page: PageData }> = [];
	const claims: string[] = [];
	const loads: string[] = [];
	const notices: string[] = [];
	/** Every `eraseWholeStrokes()` call: proof the host member is read at all. */
	let wholeReads = 0;
	// Blank lines around the breaks, the way a real deck is written: a bare
	// `slide 0\n---` is a setext heading, not a slide break (CommonMark, and
	// what Obsidian's presenter counts).
	const source =
		opts.source === undefined
			? Array.from({ length: n }, (_, i) => `slide ${i}`).join("\n\n---\n\n")
			: opts.source;
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: async () => source,
		readPageId: () => (opts.pageId === undefined ? "note-1" : opts.pageId),
		claimId: async (path, proposed) => {
			claims.push(path);
			if (opts.claim) return opts.claim(path, proposed);
			return { pageId: proposed };
		},
		newPageId: () => "note-1",
		loadSidecar: async (sidecarId) => {
			loads.push(sidecarId);
			return opts.load ? opts.load(sidecarId) : null;
		},
		scheduleSidecar: (id, page) => void scheduled.push({ id, page }),
		saveSidecarNow: async (id, page) => {
			savedNow.push({ id, page });
			await opts.saveNow?.(id, page);
		},
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => {
			wholeReads++;
			return opts.eraseWhole ?? true;
		},
		notify: (message) => void notices.push(message),
		buildId: TEST_BUILD_ID,
	};
	const deck = new SlidesDeck(
		container as unknown as HTMLElement,
		reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement,
		host
	);
	let t = 0;
	const ev = (type: string, over: Partial<AnyEvent> = {}): AnyEvent => ({
		type,
		pointerId: 1,
		pointerType: "pen",
		isPrimary: true,
		buttons: 1,
		button: 0,
		clientX: 200,
		clientY: 200,
		pressure: 0.5,
		timeStamp: (t += 20),
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
		...over,
	});
	return {
		deck,
		reveal,
		slides,
		win,
		doc,
		scheduled,
		savedNow,
		claims,
		loads,
		notices,
		logs: deckLogs,
		wholeReads: () => wholeReads,
		down: (over) => reveal.dispatch(ev("pointerdown", over)),
		move: (x, y, over) => reveal.dispatch(ev("pointermove", { clientX: x, clientY: y, ...over })),
		moveCoalesced: (points, over) => {
			const last = points[points.length - 1]!;
			const base = ev("pointermove", { clientX: last.x, clientY: last.y, ...over });
			// Each coalesced sample carries its own timestamp, the way a real
			// one does: the builder rejects points that share an instant, so a
			// list of three identical stamps would drop two and the test would
			// pass with the source reading only the last.
			const list = points.map((p, i) => ({
				...base,
				clientX: p.x,
				clientY: p.y,
				timeStamp: (base.timeStamp as number) - (points.length - 1 - i) * 4,
			}));
			base.getCoalescedEvents = () => list;
			reveal.dispatch(base);
		},
		end: (type, over) => reveal.dispatch(ev(type, over)),
		click: () => {
			const seen = { stopped: false };
			reveal.dispatch(ev("click", { stopPropagation: () => void (seen.stopped = true) }));
			return seen;
		},
	};
}

function drawStrokeOn(rig: Rig): void {
	rig.down();
	rig.move(260, 260);
	rig.move(300, 300);
	rig.end("pointerup");
}

const SECOND = "\n\n---\n\n# Two";

interface Case {
	name: string;
	/** The note's first slide, as written. */
	first: string;
	/** The first <section>'s textContent as a Markdown renderer produces it. */
	rendered: string;
}

const control: Case = {
	name: "control: plain heading and paragraph",
	first: "# Quarterly review\n\nPlain words here",
	rendered: "Quarterly reviewPlain words here",
};

const cases: Case[] = [
	{
		// <h1>Using <code>git rebase</code></h1><p>Some text</p>
		name: "inline code in the title",
		first: "# Using `git rebase`\n\nSome text",
		rendered: "Using git rebaseSome text",
	},
	{
		// <h1>Intro to <code>git</code></h1><p>By Alan</p>
		name: "inline code, short title",
		first: "# Intro to `git`\n\nBy Alan",
		rendered: "Intro to gitBy Alan",
	},
	{
		// <h1>Quarterly review</h1><p><img alt="logo" src="logo.png"></p>  (img has no text)
		name: "markdown image with alt text",
		first: "# Quarterly review\n\n![logo](logo.png)",
		rendered: "Quarterly review",
	},
	{
		// <p>See <a class="internal-link" data-href="Plan">the plan</a> now</p>
		name: "aliased wikilink",
		first: "# Intro\n\nSee [[Plan|the plan]] now",
		rendered: "IntroSee the plan now",
	},
	{
		// <li class="task-list-item"><input type="checkbox" checked>done</li>
		name: "checked task",
		first: "# Agenda\n\n- [x] done",
		rendered: "Agenda\ndone\n",
	},
	{
		// <span class="internal-embed image-embed is-loaded"><img ...></span>
		name: "sized image embed (loaded)",
		first: "# Quarterly review\n\n![[logo.png|300]]",
		rendered: "Quarterly review",
	},
];

async function runCase(c: Case): Promise<void> {
	const source = c.first + SECOND;
	const deckTexts = [c.rendered, "Two"];
	// Precondition: the counts agree, so only the first-slide fingerprint can decide.
	expect(splitSlideSections(source)).toHaveLength(2);
	const rig = makeRig({ source, sections: 2, sectionText: (i) => deckTexts[i]!, pageId: "note-1" });
	await Promise.all(rig.deck.inFlightWork());
	await new Promise((r) => setTimeout(r, 0));
	// Correct behaviour: this IS the note on screen.
	expect.soft(noteMatchesDeck(splitSlideSections(source), deckTexts), "noteMatchesDeck").toBe(true);
	expect.soft(rig.logs.join("\n"), "log").not.toContain("note check failed");
	// The saved presentation ink is looked up under the note's id.
	expect.soft(rig.loads, "sidecar loads").toEqual(["note-1.slides"]);
	drawStrokeOn(rig);
	await new Promise((r) => setTimeout(r, 0));
	// The new stroke is scheduled for saving and nothing says it is not.
	expect.soft(rig.scheduled.length, "strokes scheduled for save").toBe(1);
	expect.soft(rig.notices, "notices").toEqual([]);
	rig.deck.dispose();
}

describe("Slides-1-1: note check vs common first-slide Markdown", () => {
	it(control.name, async () => {
		await runCase(control);
	});
	it.each(cases)("$name", async (c) => {
		await runCase(c);
	});
});
