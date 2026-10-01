/**
 * AUDIT PROBE Slides-2-3 (1.4.21, 1a05f62c). Verifier, lens EXECUTION.
 *
 * Claim: the presentation pen-tools strip is mounted on `.slides-container`
 * (SlidesInkSurface.ts:2170 -> main.ts:5065 -> SlidesTools.ts:60), a sibling
 * of `.reveal`, and its buttons only preventDefault their pointerdown
 * (MobileTools.ts:1519-1520). The press bubbles to the document, where
 * Reveal's Focus controller (embedded, keyboardCondition "focused") blurs the
 * deck because the target is not inside `.reveal`; the arrow keys and a
 * clicker then stop moving slides until the next pointerdown on `.reveal`.
 *
 * Production code run: the REAL SlidesDeck (constructor, pointer listeners,
 * ensureDeckFocused, mount timer) with host.mountTools wired exactly as
 * main.ts:5065 wires it (the REAL mountSlidesTools -> buildSlidesTools -> REAL
 * MobileTools). DOM: src/testUtils/fakeDom.ts, the presentation rig
 * UnloadFlushColdReopen.test.ts uses, plus the real body > .slides-container >
 * .reveal parentage (Obsidian 1.13.7 app.js: r.createDiv("reveal")).
 *
 * Harness, not code under test: (1) a DOM event dispatcher with capture /
 * target / bubble phases and stopPropagation, because FakeEl.dispatch only
 * calls the element's own listeners; (2) Reveal's Focus + keyboard gate,
 * transcribed from the reveal.js that Obsidian 1.13.7 ships
 * (obsidian-1.13.7.asar @23350200 class W: onRevealPointerDown -> focus();
 * onDocumentPointerDown: closest(target,".reveal") === revealEl || blur();
 * @23327300 onDocumentKeyDown: "focused"===keyboardCondition &&
 * !isFocused() -> return).
 *
 * Asserts the CORRECT behaviour: after a strip press Reveal is still focused
 * and Right Arrow still advances. Controls: a press on `.reveal` keeps focus
 * and a press on an unrelated outside element blurs, so the emulated gate
 * discriminates; the strip exists and its button carries the production
 * pointerdown listener, so a green would mean something.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { SlidesDeck, type SlidesInkHost, setSlidesInk } from "./SlidesInkSurface";
import { mountSlidesTools } from "./SlidesTools";
import { resetPenToolsForTest, setPenToolsMode } from "../inline/PenToolsMode";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { repaintAllInkOverlays } from "../inline/InkOverlay";

// ---------------------------------------------------------------- listener registry
// FakeEl/FakeDoc drop the options argument; record capture-ness beside them so
// the dispatcher can run real phases. Registration still goes through to the
// fake's own map (unchanged behaviour for every other reader).
type Entry = { fn: (ev: unknown) => void; capture: boolean };
const registry = new WeakMap<object, Map<string, Entry[]>>();
function record(self: object, type: string, fn: (ev: unknown) => void, opts: unknown): void {
	const capture = typeof opts === "boolean" ? opts : !!(opts as { capture?: boolean } | undefined)?.capture;
	let byType = registry.get(self);
	if (!byType) registry.set(self, (byType = new Map()));
	const list = byType.get(type) ?? [];
	list.push({ fn, capture });
	byType.set(type, list);
}
const elProto = Object.getPrototypeOf(FakeEl.prototype) as { addEventListener: (...a: unknown[]) => void };
const docProto = FakeDoc.prototype as unknown as { addEventListener: (...a: unknown[]) => void };
const origEl = elProto.addEventListener;
const origDoc = docProto.addEventListener;
elProto.addEventListener = function (this: object, type: unknown, fn: unknown, opts?: unknown) {
	record(this, type as string, fn as (ev: unknown) => void, opts);
	return origEl.call(this, type, fn, opts);
};
docProto.addEventListener = function (this: object, type: unknown, fn: unknown, opts?: unknown) {
	record(this, type as string, fn as (ev: unknown) => void, opts);
	return origDoc.call(this, type, fn, opts);
};

/** DOM dispatch: capture (doc, ancestors top-down), target, bubble (ancestors, doc). */
function dispatch(doc: FakeDoc, target: FakeEl, init: Record<string, unknown>): { stopped: boolean } {
	const state = { stopped: false, immediate: false };
	const ev: Record<string, unknown> = {
		target,
		bubbles: true,
		defaultPrevented: false,
		preventDefault(): void {
			ev.defaultPrevented = true;
		},
		stopPropagation(): void {
			state.stopped = true;
		},
		stopImmediatePropagation(): void {
			state.stopped = true;
			state.immediate = true;
		},
		...init,
	};
	const ancestors: FakeEl[] = [];
	for (let p = target.parentElement; p; p = p.parentElement) ancestors.push(p);
	const run = (node: object, phase: "capture" | "target" | "bubble"): void => {
		const list = (registry.get(node)?.get(init.type as string) ?? []).slice();
		ev.currentTarget = node;
		for (const e of list) {
			if (phase === "capture" && !e.capture) continue;
			if (phase === "bubble" && e.capture) continue;
			e.fn(ev);
			if (state.immediate) return;
		}
	};
	const capturePath: object[] = [doc, ...ancestors.slice().reverse()];
	for (const node of capturePath) {
		run(node, "capture");
		if (state.stopped) return state;
	}
	run(target, "target");
	if (state.stopped) return state;
	for (const node of [...ancestors, doc]) {
		run(node, "bubble");
		if (state.stopped) return state;
	}
	return state;
}

// ---------------------------------------------------------------- Reveal emulation
// reveal.js as shipped in Obsidian 1.13.7 (see header). Only the Focus
// controller and the keyboardCondition gate of onDocumentKeyDown.
class RevealFocusEmu {
	state: "focus" | "blur" | undefined = undefined;
	slide = 0;
	constructor(
		private readonly doc: FakeDoc,
		private readonly revealEl: FakeEl
	) {
		// configure(): embedded -> blur(); bind(): embedded -> reveal pointerdown.
		this.blur();
		revealEl.addEventListener("pointerdown", () => this.focus());
		// Bound once here; real Reveal adds/removes it in focus()/blur(), and
		// onDocumentPointerDown only does anything while focused, so gating on
		// state is the same behaviour.
		doc.addEventListener("pointerdown", (e) => this.onDocumentPointerDown(e as { target: FakeEl }));
		doc.addEventListener("keydown", (e) => this.onDocumentKeyDown(e as { key: string }));
	}
	focus(): void {
		if (this.state !== "focus") this.revealEl.classList.add("focused");
		this.state = "focus";
	}
	blur(): void {
		if (this.state !== "blur") this.revealEl.classList.remove("focused");
		this.state = "blur";
	}
	isFocused(): boolean {
		return this.state === "focus";
	}
	private onDocumentPointerDown(e: { target: FakeEl }): void {
		if (this.state !== "focus") return; // listener not attached while blurred
		let t: FakeEl | null = e.target;
		while (t && !t.classes.has("reveal")) t = t.parentElement;
		if (!(t && t === this.revealEl)) this.blur();
	}
	private onDocumentKeyDown(e: { key: string }): void {
		// keyboardCondition: "focused" (Obsidian's presenter config)
		if (!this.isFocused()) return;
		if (e.key === "ArrowRight" || e.key === "PageDown") this.slide++;
	}
}

// ---------------------------------------------------------------- presentation rig
function presentation(): { doc: FakeDoc; container: FakeEl; reveal: FakeEl; slides: FakeEl; outside: FakeEl } {
	const doc = new FakeDoc();
	const bodyEl = new FakeEl("body", doc);
	const container = new FakeEl("div", doc, { cls: "slides-container" });
	const reveal = new FakeEl("div", doc, { cls: "reveal" });
	const slides = new FakeEl("div", doc, { cls: "slides" });
	bodyEl.appendChild(container);
	container.appendChild(reveal);
	const outside = new FakeEl("div", doc, { cls: "workspace" });
	bodyEl.appendChild(outside);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	for (let i = 0; i < 3; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	// Same answers the UnloadFlushColdReopen rig gives (findDeck's lookups).
	container.querySelector = ((sel: string) => (sel === ".reveal" ? reveal : null)) as never;
	reveal.querySelector = ((sel: string) => (sel === ".slides" ? slides : null)) as never;
	doc.container = container;
	return { doc, container, reveal, slides, outside };
}

function host(exec: (id: string) => void = () => {}): SlidesInkHost {
	return {
		// main.ts:5065, with a do-nothing command registry and notice.
		mountTools: (parent, actions) => mountSlidesTools(parent, actions, {} as never, exec, () => {}),
		activeFilePath: () => "Deck.md",
		readSource: async () => "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2",
		readPageId: () => "deck-page",
		claimId: async (_p, proposed) => ({ pageId: proposed }),
		newPageId: () => "deck-page",
		loadSidecar: async () => null,
		scheduleSidecar: () => {},
		saveSidecarNow: async () => {},
		nib: () => ({ tool: "pen", color: "#000000", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => {},
		buildId: "audit-slides-2-3",
	};
}

function walk(el: FakeEl, out: FakeEl[] = []): FakeEl[] {
	for (const kid of el.children) {
		out.push(kid);
		walk(kid, out);
	}
	return out;
}
const hasDown = (el: FakeEl): boolean => (registry.get(el)?.get("pointerdown")?.length ?? 0) > 0;

const drain = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("Slides-2-3: a press on the presentation pen strip must not unfocus Reveal", () => {
	let deck: SlidesDeck | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		(globalThis as { window?: unknown }).window = globalThis;
		(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
			observe(): void {}
			disconnect(): void {}
		};
		resetPenToolsForTest();
		setPenToolsMode("show"); // strip visible (trigger: mode show / pen seen)
	});

		afterEach(async () => {
			setDiagnosticsEnabled(false);
		deck?.dispose();
		deck = null;
		setSlidesInk(false);
		await drain();
		delete (globalThis as { document?: unknown }).document;
		delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
		vi.useRealTimers();
	});

	function mount(exec: (id: string) => void = () => {}) {
		const p = presentation();
		(globalThis as { document?: unknown }).document = p.doc;
		const reveal = new RevealFocusEmu(p.doc, p.reveal);
		// Obsidian's presenter: setTimeout(() => s.dispatchEvent(new PointerEvent("pointerdown")), 0)
		dispatch(p.doc, p.reveal, { type: "pointerdown", pointerType: "", pointerId: 0, isPrimary: false, button: 0, buttons: 0, clientX: 0, clientY: 0 });
		expect(reveal.isFocused(), "rig: Obsidian's synthetic pointerdown did not focus Reveal").toBe(true);
		deck = new SlidesDeck(p.container as never, p.reveal as never, p.slides as never, host(exec));
		return { ...p, revealEmu: reveal };
	}

	async function settle(doc: FakeDoc): Promise<void> {
		await drain();
		vi.runOnlyPendingTimers();
		doc.flushFrames();
		await drain();
	}

	function stripButton(container: FakeEl): { root: FakeEl; button: FakeEl; pill: FakeEl | null } {
		const root = walk(container).find((e) => e.classes.has("handwriting-slides-tools"));
		if (!root) throw new Error("precondition: no .handwriting-slides-tools root - strip never built");
		const strip = walk(root).find((e) => e.classes.has("handwriting-mobile-tools"));
		if (!strip) throw new Error("precondition: no .handwriting-mobile-tools strip under the root");
		const buttons = walk(strip).filter((e) => e.tagName === "button" && hasDown(e));
		const button = buttons.find((e) => /^(pen|highlighter|undo)/i.test(e.dataset.tipLabel ?? e.attrs.get("aria-label") ?? "")) ?? buttons[0];
		if (!button) throw new Error("precondition: no strip button with a pointerdown listener");
		const pill = walk(root).find((e) => e.classes.has("handwriting-pen-pill")) ?? null;
		return { root, button, pill };
	}

	it("CONTROL: the emulated Reveal gate discriminates (press on .reveal keeps focus, press outside blurs)", async () => {
		const p = mount();
		await settle(p.doc);
		dispatch(p.doc, p.reveal, { type: "pointerdown", pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: 900, clientY: 700, timeStamp: 1 });
		dispatch(p.doc, p.reveal, { type: "pointerup", pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 0, clientX: 900, clientY: 700, timeStamp: 2 });
		expect(p.revealEmu.isFocused(), "press on .reveal must keep Reveal focused").toBe(true);
		dispatch(p.doc, p.reveal, { type: "keydown", key: "ArrowRight" });
		expect(p.revealEmu.slide, "focused Reveal must advance on Right Arrow").toBeGreaterThanOrEqual(1);
		dispatch(p.doc, p.outside, { type: "pointerdown", pointerType: "mouse", pointerId: 2, isPrimary: true, button: 0, buttons: 1, clientX: 5, clientY: 5 });
		expect(p.revealEmu.isFocused(), "press outside .reveal must blur the emulated Reveal").toBe(false);
	});

	for (const pointerType of ["pen", "mouse", "touch"] as const) {
		it(`${pointerType} press on a strip button leaves Reveal focused and Right Arrow still advances`, async () => {
			const p = mount();
			await settle(p.doc);
			const { root, button } = stripButton(p.container);

			// Precondition facts about where production code put the strip.
			let insideReveal = false;
			for (let a: FakeEl | null = button; a; a = a.parentElement) if (a === p.reveal) insideReveal = true;
			const rootParent = root.parentElement;
			// Recorded, not the red: the outcome assertions below are.
			const placement = `tools root parent=${rootParent?.classes.has("slides-container") ? ".slides-container" : String(rootParent?.tagName)}, button "${button.dataset.tipLabel ?? button.attrs.get("aria-label") ?? "?"}" inside .reveal=${insideReveal}`;
			expect(p.revealEmu.isFocused(), "precondition: Reveal focused before the press").toBe(true);

			const res = dispatch(p.doc, button, { type: "pointerdown", pointerType, pointerId: 11, isPrimary: true, button: 0, buttons: 1, clientX: 40, clientY: 40, timeStamp: 100 });
			dispatch(p.doc, button, { type: "pointerup", pointerType, pointerId: 11, isPrimary: true, button: 0, buttons: 0, clientX: 40, clientY: 40, timeStamp: 140 });
			dispatch(p.doc, button, { type: "click", pointerType, button: 0, clientX: 40, clientY: 40, timeStamp: 141 });
			await settle(p.doc);

			const before = p.revealEmu.slide;
			dispatch(p.doc, p.reveal, { type: "keydown", key: "ArrowRight" });

			expect(
				p.revealEmu.isFocused(),
				`Reveal lost focus after a ${pointerType} press on the strip (${placement}; propagation stopped=${res.stopped})`
			).toBe(true);
			expect(p.revealEmu.slide, `Right Arrow did not advance after the strip press (${placement})`).toBe(before + 1);
		});
	}

	it("holding the recording dot forwards the stop command", async () => {
		setDiagnosticsEnabled(true);
		const commands: string[] = [];
		const p = mount(id => commands.push(id));
		await settle(p.doc);
		const dot = walk(p.container).find(el => el.classes.has("handwriting-recording-dot"));
		expect(dot).toBeDefined();
		dispatch(p.doc, dot!, { type: "pointerdown", pointerType: "touch", pointerId: 12, buttons: 1 });
		vi.advanceTimersByTime(600);
		expect(commands).toContain("handwriting:toggle-diagnostics");
	});

	it.each(["show", "hide"] as const)("settings repaint reaches a live slides deck with tools %s", async mode => {
		setPenToolsMode(mode);
		const p = mount();
		await settle(p.doc);
		const repaint = vi.spyOn(deck as unknown as { repaint: () => void }, "repaint");
		repaintAllInkOverlays();
		expect(repaint).toHaveBeenCalledTimes(1);
		repaint.mockRestore();
	});

	it("settings repaint stops reaching the deck after it is disposed", async () => {
		setPenToolsMode("hide");
		const p = mount();
		await settle(p.doc);
		const repaint = vi.spyOn(deck!, "repaintSettings");
		repaintAllInkOverlays();
		expect(repaint).toHaveBeenCalledTimes(1);
		deck!.dispose();
		repaintAllInkOverlays();
		expect(repaint).toHaveBeenCalledTimes(1);
		repaint.mockRestore();
	});
});
