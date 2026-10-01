/**
 * Cells for test/popoutWindow.ts, the second-window fake the E4 popout probes
 * stand on. A probe that goes green on a harness that cannot see anything
 * proves nothing, so each door the harness offers is pinned here first: its
 * listeners are counted and its close fires in browser order, its clock and
 * frames are its own and not the global ones, its timers stop when it closes,
 * and its document's hidden state is its own.
 */
import { describe, expect, it } from "vitest";
import { makePopoutWindow } from "../../test/popoutWindow";

describe("popout window harness", () => {
	it("counts window, document and media listeners, and records each add and remove", () => {
		const p = makePopoutWindow();
		const fn = () => {};
		p.window.addEventListener("beforeprint", fn);
		p.document.addEventListener("visibilitychange", fn);
		const mq = p.window.matchMedia("print");
		mq.addEventListener("change", fn);
		expect([p.listeners("beforeprint"), p.documentListeners("visibilitychange"), p.mediaListeners("print")]).toEqual([1, 1, 1]);

		p.window.removeEventListener("beforeprint", fn);
		mq.removeEventListener("change", fn);
		expect([p.listeners("beforeprint"), p.mediaListeners("print")]).toEqual([0, 0]);
		expect(p.calls.map((c) => `${c.op} ${c.target} ${c.type}`)).toEqual([
			"add window beforeprint",
			"add document visibilitychange",
			"add media:print change",
			"remove window beforeprint",
			"remove media:print change",
		]);
	});

	it("the document's defaultView is the popout window, not the global one", () => {
		const p = makePopoutWindow();
		expect(p.document.defaultView).toBe(p.window);
		expect(p.window.document).toBe(p.document);
		expect(p.window).not.toBe(globalThis);
	});

	it("close fires beforeunload, pagehide, unload in that order, then marks calls afterClose", () => {
		const p = makePopoutWindow();
		const seen: string[] = [];
		for (const t of ["unload", "pagehide", "beforeunload"]) p.window.addEventListener(t, () => void seen.push(t));
		expect(p.closed).toBe(false);
		p.close();
		expect(seen).toEqual(["beforeunload", "pagehide", "unload"]);
		expect(p.closed).toBe(true);
		expect(p.window.closed).toBe(true);

		p.window.removeEventListener("unload", () => {});
		expect(p.calls.filter((c) => c.afterClose).map((c) => `${c.op} ${c.type}`)).toEqual(["remove unload"]);
		p.close();
		expect(seen).toHaveLength(3);
	});

	it("keeps its own clock: performance.now and frame timestamps never read the global", () => {
		const p = makePopoutWindow({ clockStart: 5 });
		const q = makePopoutWindow({ clockStart: 9_000_000 });
		expect(p.window.performance.now()).toBe(5);
		expect(q.window.performance.now()).toBe(9_000_000);

		const stamps: number[] = [];
		p.window.requestAnimationFrame((t) => void stamps.push(t));
		p.advance(16);
		expect(p.pendingFrames()).toBe(1);
		p.frame();
		expect(stamps).toEqual([21]);
		expect(p.pendingFrames()).toBe(0);
		expect(q.window.performance.now()).toBe(9_000_000);
	});

	it("frames can be cancelled, and none run once the window has closed", () => {
		const p = makePopoutWindow();
		const ran: string[] = [];
		const a = p.window.requestAnimationFrame(() => void ran.push("a"));
		p.window.requestAnimationFrame(() => void ran.push("b"));
		p.window.cancelAnimationFrame(a);
		p.frame();
		expect(ran).toEqual(["b"]);

		p.window.requestAnimationFrame(() => void ran.push("c"));
		p.close();
		p.frame();
		expect(ran).toEqual(["b"]);
	});

	it("runs its own timers in due order on advance, and none after close", () => {
		const p = makePopoutWindow({ clockStart: 100 });
		const ran: Array<[string, number]> = [];
		p.window.setTimeout(() => void ran.push(["late", p.window.performance.now()]), 50);
		p.window.setTimeout(() => void ran.push(["early", p.window.performance.now()]), 10);
		const gone = p.window.setTimeout(() => void ran.push(["cleared", 0]), 20);
		p.window.clearTimeout(gone);
		p.advance(60);
		expect(ran).toEqual([["early", 110], ["late", 150]]);
		expect(p.window.performance.now()).toBe(160);

		p.window.setTimeout(() => void ran.push(["after close", 0]), 1);
		p.close();
		p.advance(10);
		expect(ran).toHaveLength(2);
		expect(p.pendingTimers()).toBe(1);
	});

	it("hidden is this window's own, and a change reaches document listeners before window ones", () => {
		const p = makePopoutWindow({ hidden: true });
		const q = makePopoutWindow();
		expect([p.document.hidden, p.document.visibilityState]).toEqual([true, "hidden"]);
		expect([q.document.hidden, q.document.visibilityState]).toEqual([false, "visible"]);

		const order: string[] = [];
		p.window.addEventListener("visibilitychange", () => void order.push("window"));
		p.document.addEventListener("visibilitychange", () => void order.push("document"));
		p.setHidden(false);
		expect(order).toEqual(["document", "window"]);
		expect(p.document.hidden).toBe(false);
		expect(q.document.hidden).toBe(false);
	});

	it("dispatch hands the event type and extras to each listener, and a listener may remove itself", () => {
		const p = makePopoutWindow();
		const got: unknown[] = [];
		const once = (ev: { type: string }) => {
			got.push(ev);
			p.window.removeEventListener("beforeprint", once as never);
		};
		p.window.addEventListener("beforeprint", once as never);
		p.window.addEventListener("beforeprint", ((ev: { type: string }) => void got.push(ev.type)) as never);
		p.dispatch("beforeprint", { detail: 1 });
		p.dispatch("beforeprint");
		expect(got).toEqual([{ type: "beforeprint", detail: 1 }, "beforeprint", "beforeprint"]);
	});

	it("each matchMedia call is its own list: a remove through a fresh list for the same query removes nothing", () => {
		const p = makePopoutWindow();
		const fn = () => {};
		const first = p.window.matchMedia("print");
		first.addEventListener("change", fn);
		p.window.matchMedia("print").removeEventListener("change", fn);
		expect(p.mediaListeners("print")).toBe(1);
		first.removeEventListener("change", fn);
		expect(p.mediaListeners("print")).toBe(0);
	});

	it("a listener is the pair (function, capture): duplicates are ignored, remove must match capture", () => {
		const p = makePopoutWindow();
		const fn = () => {};
		p.document.addEventListener("pointerdown", fn, { capture: true });
		p.document.addEventListener("pointerdown", fn, true);
		expect(p.documentListeners("pointerdown")).toBe(1);
		p.document.addEventListener("pointerdown", fn);
		expect(p.documentListeners("pointerdown")).toBe(2);
		p.document.removeEventListener("pointerdown", fn);
		expect(p.documentListeners("pointerdown")).toBe(1);
		p.document.removeEventListener("pointerdown", fn, { capture: true });
		expect(p.documentListeners("pointerdown")).toBe(0);
	});

	it("a once listener runs once and is gone, and one removed mid-dispatch does not run", () => {
		const p = makePopoutWindow();
		const ran: string[] = [];
		const late = () => void ran.push("late");
		p.window.addEventListener("pagehide", () => void ran.push("once"), { once: true });
		p.window.addEventListener("pagehide", () => {
			ran.push("remover");
			p.window.removeEventListener("pagehide", late);
		});
		p.window.addEventListener("pagehide", late);
		p.dispatch("pagehide");
		p.dispatch("pagehide");
		expect(ran).toEqual(["once", "remover", "remover"]);
		expect(p.listeners("pagehide")).toBe(1);
	});

	it("dispatchDocument reaches the document's listeners and not the window's", () => {
		const p = makePopoutWindow();
		const got: string[] = [];
		p.document.addEventListener("pointerdown", ((ev: { type: string; pointerId: number }) =>
			void got.push(`document ${ev.type} ${ev.pointerId}`)) as never);
		p.window.addEventListener("pointerdown", (() => void got.push("window")) as never);
		p.dispatchDocument("pointerdown", { pointerId: 7 });
		expect(got).toEqual(["document pointerdown 7"]);
	});
});
