/**
 * The Attach button is one tap: with free ink (or part of a group with free ink) selected a tap attaches it, with one
 * whole attached group selected a tap detaches it. No menu opens, for the pen, the mouse and the finger alike. A finger
 * tap on the button is the overlay's: it is kept from the text, so the cursor does not move. Hovering a pen or an armed
 * mouse over the button shows "Attach".
 *
 * The overlay cells drive the real lasso contact (lassoDown, lassoUp) and the real finger tap (tapReleasesSelection, the
 * router's onTapLift) on the bare overlay of attachTapRig.test.util.ts, with a view that answers the line reads Attach
 * makes. The router cells drive the real InlinePenRouter's pointer handlers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";

/** Every displayTooltip call, in order: the hover cells read what the overlay asked Obsidian to show. */
const tooltips = vi.hoisted(() => [] as { el: unknown; text: unknown; opts: unknown }[]);
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	displayTooltip: (el: unknown, text: unknown, opts: unknown) => void tooltips.push({ el, text, opts }),
}));
import { InlinePenRouter } from "./InlinePenRouter";
import { inlineInk } from "./InkOverlayRegistry";
import { attachButtonPoint, HANDLE_TOUCH_PX } from "./LassoTransform";
import { ATTACH_STRINGS } from "./AttachDecoration";
import { doc, tapRig, type RigOpts } from "./attachTapRig.test.util";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";
import type { AttachmentRecord } from "./InkAttachments";
import { mountOverlay } from "./mountRig.test.util";
import css from "../../styles.css?raw";

let restore: () => void;
beforeAll(() => {
	restore = installFakeWindow();
});
afterAll(() => restore());

const G1 = ["c1", "c2"];
type Menuish = { last: unknown };
const menu = () => (obsidian as unknown as { Menu: Menuish }).Menu;

/** The tap rig with a view that answers Attach's line reads: lines 40 world units tall from 0, read at once. */
function toggleRig(path: string, opts: RigOpts = {}) {
	const r = tapRig(path, opts);
	Object.assign((r.overlay as unknown as { view: object }).view, {
		scaleY: 1,
		lineBlockAt: () => ({ top: 80, bottom: 120 }),
		lineBlockAtHeight: (h: number) => {
			const line = doc.line(Math.max(1, Math.min(doc.lines, Math.floor(h / 40) + 1)));
			return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	});
	Object.assign(r.overlay, {
		fontZoom: 1,
		followRefAt: () => ({ x: 3, y: 200 }),
		endLiveGestureForHistory: () => {},
		repaintPath: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		lastSyncRectLeft: 300,
		lastSyncRectTop: 50,
	});
	const o = r.overlay as unknown as {
		selectionBounds(): { x: number; y: number; width: number; height: number } | null;
		lassoDown(s: object, input: string): void;
		lassoMove(s: object[]): void;
		lassoUp(): void;
		dragTotal: unknown;
		lassoActive: boolean;
	};
	const select = (ids: string[]) => {
		r.selection.selectExactly(ids);
		r.redraw();
	};
	/** The button's centre, world units (zoom 1 in this rig). */
	const button = () => attachButtonPoint(o.selectionBounds()!, 1, 1);
	const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	/** A pen, mouse or finger contact through the lasso: down, a 2 px wobble, up. */
	const press = (x: number, y: number, input: "pen" | "mouse" | "touch") => {
		o.lassoDown(sample(x, y), input);
		o.lassoMove([sample(x + 2, y + 1)]);
		o.lassoUp();
	};
	const groups = () => inlineInk.attachments(path).map((a) => ({ id: a.id, strokeIds: [...(a as AttachmentRecord).strokeIds].sort() }));
	return { ...r, o, select, button, sample, press, groups };
}

/** Let the measure's write and its microtask run. */
const settle = () => Promise.resolve();

describe("the Attach button is one tap: no menu", () => {
	it("a finger tap on the button with free ink selected attaches it, and the tap is kept from the text", async () => {
		// Defect (1.5.0): a finger tap on the button answers false, so it falls through to the text and nothing attaches.
		const r = toggleRig("toggle-finger-free.md");
		r.select(["free"]);
		menu().last = null;
		const b = r.button();
		const answer = r.tapAt(b.x, b.y);
		await settle();
		expect(answer, "the overlay took the tap").toBe(true);
		expect(r.groups(), "the free line is a group of its own now").toEqual([
			{ id: "g1", strokeIds: G1 },
			{ id: "g2", strokeIds: ["d1", "d2"] },
			{ id: expect.any(String), strokeIds: ["free"] },
		]);
		expect(menu().last, "no menu").toBeNull();
	});

	it("a finger tap on the button with one whole attached group selected detaches it, and the tap is kept", () => {
		// Defect (1.5.0): the tap falls through to the text and the group stays attached.
		const r = toggleRig("toggle-finger-group.md");
		r.select(G1);
		menu().last = null;
		const b = r.button();
		const answer = r.tapAt(b.x, b.y);
		expect(answer, "the overlay took the tap").toBe(true);
		expect(r.groups().map((g) => g.id), "g1 detached").toEqual(["g2"]);
		expect(menu().last, "no menu").toBeNull();
	});

	it("a pen tap on the button with free ink selected attaches it; no menu opens", async () => {
		// Defect (1.5.0): the lift opens a menu and attaches nothing until an item is picked.
		const r = toggleRig("toggle-pen-free.md");
		r.select(["free"]);
		menu().last = null;
		const b = r.button();
		r.press(b.x, b.y, "pen");
		await settle();
		expect(menu().last, "no menu").toBeNull();
		expect(r.groups().map((g) => g.strokeIds), "the free line attached").toContainEqual(["free"]);
		expect(r.selected(), "the selection stays").toEqual(["free"]);
	});

	it("a pen tap on the button with one whole attached group selected detaches it; no menu opens", () => {
		// Defect (1.5.0): the lift opens a menu with Attach and Detach.
		const r = toggleRig("toggle-pen-group.md");
		r.select(G1);
		menu().last = null;
		const b = r.button();
		r.press(b.x, b.y, "pen");
		expect(menu().last, "no menu").toBeNull();
		expect(r.groups().map((g) => g.id), "g1 detached").toEqual(["g2"]);
		expect(r.selected(), "the selection stays").toEqual(G1);
	});

	it("a mouse tap on the button with a group and free ink selected attaches the free ink to that group", async () => {
		// Defect (1.5.0): the lift opens a menu.
		const r = toggleRig("toggle-mouse-mixed.md");
		r.select([...G1, "free"]);
		menu().last = null;
		const b = r.button();
		r.press(b.x, b.y, "mouse");
		await settle();
		expect(menu().last, "no menu").toBeNull();
		expect(r.groups()[0], "g1 holds the free line too").toEqual({ id: "g1", strokeIds: ["c1", "c2", "free"] });
	});

	it("two taps: attach, then detach; each tap acts once", async () => {
		// Defect: one tap runs the toggle twice (attach then detach), so nothing seems to happen.
		const r = toggleRig("toggle-twice.md");
		r.select(["free"]);
		const b = r.button();
		r.press(b.x, b.y, "pen");
		await settle();
		expect(r.groups().map((g) => g.strokeIds), "after one tap").toContainEqual(["free"]);
		r.redraw();
		const b2 = r.button();
		r.press(b2.x, b2.y, "pen");
		await settle();
		expect(r.groups().map((g) => g.strokeIds), "after the second tap").not.toContainEqual(["free"]);
	});
});

describe("guards: what does not toggle", () => {
	it("a move past the grab pad lets the press go: nothing attaches or detaches, nothing drags", () => {
		const r = toggleRig("toggle-guard-drag.md");
		r.select(G1);
		const b = r.button();
		r.o.lassoDown(r.sample(b.x, b.y), "pen");
		r.o.lassoMove([r.sample(b.x + 30, b.y)]);
		r.o.lassoMove([r.sample(b.x, b.y)]);
		r.o.lassoUp();
		expect(r.groups().map((g) => g.id)).toEqual(["g1", "g2"]);
		expect([r.o.dragTotal, r.o.lassoActive, r.selected()]).toEqual([null, false, G1]);
	});

	it("a finger tap just outside the button's 44 px square keeps today's answer: the selection goes, the tap goes on", () => {
		const r = toggleRig("toggle-guard-outside.md");
		r.select(["free"]);
		const b = r.button();
		const answer = r.tapAt(b.x, b.y + HANDLE_TOUCH_PX / 2 + 1);
		expect([answer === true, r.selected()]).toEqual([false, []]);
		expect(r.groups().map((g) => g.id)).toEqual(["g1", "g2"]);
	});

	it("a contact the router rejects as a palm, on the button, toggles nothing and keeps the selection", () => {
		const r = toggleRig("toggle-guard-palm.md");
		r.select(G1);
		const h = routerOn(r);
		try {
			(h.router as unknown as { anyGateBlocksNewTouch: () => boolean }).anyGateBlocksNewTouch = () => true;
			const b = r.button();
			h.tap(b.x, b.y);
			expect(h.lifts(), "the palm never reached the tap").toBe(0);
			expect(r.groups().map((g) => g.id), "g1 still attached").toEqual(["g1", "g2"]);
			expect(r.selected()).toEqual(G1);
		} finally {
			h.router.dispose();
		}
	});

	it("iPhone with finger ink: a finger tap on the button is held for the selection, never inked, so the button acts once", () => {
		// The router holds a lone finger that lands on the selection (claimTouch) instead of claiming it as ink;
		// a lift inside the tap limit is a tap, so onTapLift runs the overlay's tap once and penDown never runs.
		const r = toggleRig("toggle-guard-iphone.md");
		r.select(G1);
		const h = routerOn(r, { fingerInk: true });
		try {
			const b = r.button();
			h.tap(b.x, b.y);
			expect([h.lifts(), h.downs()], "[tap lifts, pen downs]").toEqual([1, 0]);
			expect(r.groups().map((g) => g.id), "g1 detached once").toEqual(["g2"]);
		} finally {
			h.router.dispose();
		}
	});

	it("iPhone with the lasso tool: the finger's contact on the button through the lasso toggles once", () => {
		const r = toggleRig("toggle-guard-iphone-lasso.md");
		r.select(G1);
		const b = r.button();
		r.press(b.x, b.y, "touch");
		expect(r.groups().map((g) => g.id), "g1 detached once").toEqual(["g2"]);
	});
});

describe("hovering the button shows its words", () => {
	/** A body that records each element made on it and each event sent from one. */
	function body() {
		type Made = { opts: { cls?: string; attr?: Record<string, string> }; style: Record<string, string>; sent: string[]; dispatchEvent(e: Event): boolean };
		const made: Made[] = [];
		const b = {
			createDiv: (opts: Made["opts"]) => {
				const el: Made = { opts, style: {}, sent: [], dispatchEvent: (e: Event) => (el.sent.push(e.type), true) };
				made.push(el);
				return el;
			},
		};
		return { b, made };
	}
	const hoverOf = (r: ReturnType<typeof toggleRig>) => (r.overlay as unknown as { attachHover?: (s: object, pointerType: string) => void }).attachHover;
	const px = (v: string | undefined) => Number(String(v).replace("px", ""));

	it("a pen hovering on the button shows Attach through displayTooltip on an anchor at the button; moving off it hides it", () => {
		// Defect (1.5.0): the button has no hover words. They come from Obsidian's displayTooltip, anchored at the button's rect.
		const r = toggleRig("toggle-hover.md");
		const { b, made } = body();
		Object.assign(r.overlay, { container: { ownerDocument: { body: b } } });
		r.select(["free"]);
		const p = r.button();
		const hover = hoverOf(r);
		expect(typeof hover, "attachHover is wired").toBe("function");
		tooltips.length = 0;
		hover!.call(r.overlay, r.sample(p.x, p.y), "pen");
		expect((ATTACH_STRINGS as Record<string, string>)["button"]).toBe("Attach");
		expect(tooltips.map((t) => t.text), "displayTooltip asked for Attach").toEqual([(ATTACH_STRINGS as Record<string, string>)["button"]]);
		expect(made, "one anchor").toHaveLength(1);
		const anchor = made[0]!;
		expect(tooltips[0]!.el, "the tooltip hangs from the anchor").toBe(anchor);
		expect(anchor.opts.attr?.["aria-label"], "the anchor carries the words, so Obsidian's own leave hides it").toBe("Attach");
		expect(anchor.opts.cls, "the anchor's class").toBe("hw-attach-tip-anchor");
		const rule = /\.hw-attach-tip-anchor\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(rule, "the anchor takes no pointer events (styles.css)").toMatch(/pointer-events:\s*none;/);
		expect(rule, "the anchor is placed by its left and top (styles.css)").toMatch(/position:\s*absolute;/);
		const w = px(anchor.style.width);
		expect(w, "the anchor has the button's size").toBeGreaterThan(0);
		expect(px(anchor.style.left) + w / 2, "centred on the button, client px").toBeCloseTo(300 + p.x, 6);
		expect(px(anchor.style.top) + px(anchor.style.height) / 2, "centred on the button, client px").toBeCloseTo(50 + p.y, 6);
		hover!.call(r.overlay, r.sample(p.x, p.y + 40), "pen");
		expect(anchor.sent, "moving off sends the leave that hides Obsidian's tooltip").toEqual(["pointerout"]);
		hover!.call(r.overlay, r.sample(p.x, p.y + 41), "pen");
		expect(anchor.sent, "one leave, not one per move").toEqual(["pointerout"]);
		hover!.call(r.overlay, r.sample(p.x, p.y), "pen");
		expect(made, "the same anchor shown again, not a second one").toHaveLength(1);
		expect(tooltips, "shown again").toHaveLength(2);
		expect(tooltips[1]!.el).toBe(anchor);
	});

	/**
	 * A real mounted overlay (mountRig.test.util.ts) with the button's hit test and the selection's bounds stood in, so
	 * the hover is on the button; the anchor lands in the rig document's body. `sent` records the anchor's events.
	 */
	function mountedHover(path: string) {
		const m = mountOverlay(path);
		Object.assign(m.o, { attachButtonAt: () => true, selectionBounds: () => ({ x: 40, y: 40, width: 100, height: 60 }) });
		const sent: string[] = [];
		tooltips.length = 0;
		(m.o.attachHover as (s: object, pt: string) => void).call(m.o, { x: 90, y: 110, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, "pen");
		const anchor = m.doc.body.find("hw-attach-tip-anchor") as unknown as { dispatchEvent(e: Event): boolean } | null;
		if (anchor) anchor.dispatchEvent = (e: Event) => (sent.push(e.type), true);
		return { m, anchor, sent };
	}

	it("the pen leaving hover range over the button hides Attach at once", () => {
		const { m, anchor, sent } = mountedHover("toggle-hover-leave.md");
		try {
			expect(anchor, "the hover made its anchor").not.toBeNull();
			expect(tooltips, "Attach shown").toHaveLength(1);
			const router = m.o.router as { cb: { onPenLeave(): void } };
			router.cb.onPenLeave();
			expect(sent, "the leave that hides Obsidian's tooltip, once").toEqual(["pointerout"]);
			router.cb.onPenLeave();
			expect(sent, "not again with nothing shown").toEqual(["pointerout"]);
		} finally {
			m.destroy();
		}
	});

	it("the hover anchor goes when its overlay closes", () => {
		const { m, anchor } = mountedHover("toggle-hover-close.md");
		expect(anchor, "the hover made its anchor").not.toBeNull();
		m.destroy();
		expect(m.doc.body.find("hw-attach-tip-anchor"), "no anchor left in the body").toBeNull();
	});

	it("CONTROL: a finger over the button gets no hover words", () => {
		const r = toggleRig("toggle-hover-touch.md");
		const { b, made } = body();
		Object.assign(r.overlay, { container: { ownerDocument: { body: b } } });
		r.select(["free"]);
		const p = r.button();
		tooltips.length = 0;
		hoverOf(r)!.call(r.overlay, r.sample(p.x, p.y), "touch");
		expect(tooltips).toEqual([]);
		expect(made).toEqual([]);
	});

	it("CONTROL: with nothing selected there is no button and no tooltip", () => {
		const r = toggleRig("toggle-hover-none.md");
		const { b, made } = body();
		Object.assign(r.overlay, { container: { ownerDocument: { body: b } } });
		const hover = hoverOf(r);
		expect(typeof hover, "attachHover is wired").toBe("function");
		tooltips.length = 0;
		hover!.call(r.overlay, r.sample(100, 100), "pen");
		expect(tooltips).toEqual([]);
		expect(made).toEqual([]);
	});
});

/** The real router on a fake scroller, its onTapLift the rig's overlay tap; `fingerInk` arms finger ink. */
function routerOn(r: ReturnType<typeof tapRig>, opts: { fingerInk?: boolean } = {}) {
	const win = {
		devicePixelRatio: 1,
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
	};
	const el = Object.assign(fakeEl(), { scrollWidth: 800, clientWidth: 800, scrollHeight: 3600, clientHeight: 600, ownerDocument: { defaultView: win } });
	const rec = recorder();
	let lifts = 0, downs = 0;
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
		...rec.cb,
		onPenDown: () => void downs++,
		fingerInk: () => opts.fingerInk ?? false,
		penOff: () => false,
		claimTouch: (s: { x: number; y: number }) =>
			(r.overlay as unknown as { selectionContactAt(w: { x: number; y: number }, input: string): string | null }).selectionContactAt(r.camera.screenToWorld(s.x, s.y), "touch") !== null,
		onTapLift: (s: { x: number; y: number }, ev: object) => {
			lifts++;
			return (r.overlay as unknown as { tapReleasesSelection(s: object, ev?: object): unknown }).tapReleasesSelection(s, ev);
		},
	} as never, () => 1);
	const touch = (type: string, x: number, y: number, t: number) => {
		const ev = penEvent(type, t, { pointerId: 31, pointerType: "touch", x, y, pressure: 0, buttons: type === "pointerup" ? 0 : 1 }) as unknown as Record<string, unknown>;
		ev.preventDefault = () => {};
		ev.stopPropagation = () => {};
		const h = el.handlers.get(type);
		if (!h) throw new Error(`missing handler ${type}`);
		h(ev as unknown as Event);
	};
	const tap = (x: number, y: number) => {
		touch("pointerdown", x, y, 10);
		touch("pointerup", x, y, 90);
	};
	return { router, tap, lifts: () => lifts, downs: () => downs };
}
