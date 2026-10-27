/**
 * The foreground repaint, driven for real.
 *
 * The bug it answers is unreproducible here - it needs an iPad under memory
 * pressure, and nobody on this project has one - so what CAN be pinned is
 * the wiring: the three events are all listened for, a return that delivers
 * all three costs one repaint and not three, the hidden edge repaints
 * nothing, and teardown leaves nothing behind on the document or the window.
 *
 * Driven through the host seam rather than jsdom globals because that is
 * what the module is written against, and because the listener bookkeeping
 * is the thing under test: a fake that COUNTS its listeners can fail an
 * unregistered teardown, which a real EventTarget cannot.
 */
import { beforeEach, describe, expect, it } from "vitest";
import mainSrc from "../main.ts?raw";
import onloadSrc from "../PluginOnload.ts?raw";
import { codeOnly } from "../CodeOnly";
import {
	FOREGROUND_EVENTS,
	ForegroundHost,
	armForegroundRepaint,
} from "./ForegroundRepaint";

class FakeTarget {
	readonly listeners = new Map<string, Set<() => void>>();

	addEventListener(type: string, fn: () => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(fn);
	}

	removeEventListener(type: string, fn: () => void): void {
		this.listeners.get(type)?.delete(fn);
	}

	fire(type: string): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
	}

	count(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}

	get total(): number {
		let n = 0;
		for (const set of this.listeners.values()) n += set.size;
		return n;
	}
}

class FakeDoc extends FakeTarget {
	visibilityState = "visible";
}

class FakeWin extends FakeTarget {
	readonly timers = new Map<number, () => void>();
	private next = 1;
	cleared = 0;

	setTimeout(fn: () => void, _ms: number): number {
		const id = this.next++;
		this.timers.set(id, fn);
		return id;
	}

	clearTimeout(id: number): void {
		if (this.timers.delete(id)) this.cleared++;
	}

	get pending(): number {
		return this.timers.size;
	}

	/** Run everything queued, the way a macrotask turn would. */
	flush(): void {
		const due = [...this.timers.entries()];
		this.timers.clear();
		for (const [, fn] of due) fn();
	}
}

describe("armForegroundRepaint", () => {
	let doc: FakeDoc;
	let win: FakeWin;
	let host: ForegroundHost;
	let repaints: number;

	beforeEach(() => {
		doc = new FakeDoc();
		win = new FakeWin();
		// Every test in THIS block is exercising the mobile behaviour, so it
		// opts into the gate explicitly rather than relying on a default -
		// see the "gated on isMobileApp" block below for the desktop half.
		host = { doc, win, isMobileApp: true };
		repaints = 0;
	});

	const arm = () => armForegroundRepaint(host, () => void repaints++);

	it("registers exactly the three foreground events, one listener each", () => {
		arm();
		expect(doc.count("visibilitychange")).toBe(1);
		expect(win.count("pageshow")).toBe(1);
		expect(win.count("focus")).toBe(1);
		expect(doc.total + win.total).toBe(FOREGROUND_EVENTS.length);
	});

	it("coalesces three events in one tick into a single repaint", () => {
		arm();
		doc.visibilityState = "visible";
		doc.fire("visibilitychange");
		win.fire("pageshow");
		win.fire("focus");
		// Nothing yet: the repaint is the coalescing task, not the event.
		expect(repaints).toBe(0);
		expect(win.pending).toBe(1);
		win.flush();
		expect(repaints).toBe(1);
	});

	it("repaints again on the NEXT foreground, not only the first", () => {
		arm();
		doc.fire("visibilitychange");
		win.flush();
		win.fire("focus");
		win.flush();
		expect(repaints).toBe(2);
	});

	it("does not repaint on the hidden edge", () => {
		arm();
		doc.visibilityState = "hidden";
		doc.fire("visibilitychange");
		expect(win.pending).toBe(0);
		win.flush();
		expect(repaints).toBe(0);
	});

	it("removes every listener on teardown", () => {
		const off = arm();
		off();
		expect(doc.total).toBe(0);
		expect(win.total).toBe(0);
		doc.fire("visibilitychange");
		win.fire("pageshow");
		win.fire("focus");
		win.flush();
		expect(repaints).toBe(0);
	});

	it("drops a coalescing timer that has not fired when it is torn down", () => {
		const off = arm();
		win.fire("focus");
		expect(win.pending).toBe(1);
		off();
		expect(win.cleared).toBe(1);
		expect(win.pending).toBe(0);
		win.flush();
		expect(repaints).toBe(0);
	});

	it("never repaints after teardown even if the timer somehow runs", () => {
		// Belt and braces: `clearTimeout` is the host's promise, not ours, and
		// a plugin unloaded inside its own coalescing window must not paint
		// into views it no longer owns.
		const off = arm();
		win.fire("pageshow");
		const [fn] = [...win.timers.values()];
		off();
		fn?.();
		expect(repaints).toBe(0);
	});
});

/**
 * FOREGROUND REPAINT ON DESKTOP (auditor, 2026-09-05): the purge this file
 * exists for (design §14) is a WebKit-only canvas defect, observed on an
 * iPad, but `armForegroundRepaint` used to register its three listeners
 * unconditionally - so every desktop alt-tab back into Obsidian
 * re-rasterised every visible stroke on every open pane's canvases, for a
 * purge desktop Chromium never does. Gated on `host.isMobileApp` now, read
 * once at the call the same way `ButtonSpec.shownOn` reads a device fact
 * (MobileTools.ts) - not a live state this file needs a listener of its own
 * for.
 */
describe("armForegroundRepaint: gated on isMobileApp", () => {
	it("adds no listener at all when the platform reads as desktop", () => {
		const doc = new FakeDoc();
		const win = new FakeWin();
		const teardown = armForegroundRepaint({ doc, win, isMobileApp: false }, () => {});
		expect(doc.total).toBe(0);
		expect(win.total).toBe(0);
		// The teardown is still a callable no-op: `register` always calls it.
		expect(() => teardown()).not.toThrow();
	});

	it("registers the three foreground events when the platform reads as mobile", () => {
		const doc = new FakeDoc();
		const win = new FakeWin();
		armForegroundRepaint({ doc, win, isMobileApp: true }, () => {});
		expect(doc.total + win.total).toBe(FOREGROUND_EVENTS.length);
	});
});

/**
 * The behaviour above is worth nothing if main.ts never arms it, and
 * `src/main.ts` is imported by no test file (DeferredUnloadGuard.test.ts), so
 * a source scan is the only thing that can see the wiring. Counted on
 * `codeOnly` output, so a paragraph that merely DISCUSSES the call - like the
 * comment sitting above it - cannot make the count for a call that is not
 * there.
 */
describe("main.ts arms the foreground repaint", () => {
	// The onload phases live in PluginOnload.ts, read here with main.ts.
	const mainCode = codeOnly([mainSrc, onloadSrc].join("\n"));

	it("registers it exactly once, through `register` so unload takes it back", () => {
		const calls = mainCode.match(/armForegroundRepaint\(/g) ?? [];
		expect(calls).toHaveLength(1);
		expect(mainCode).toMatch(/this\.register\(\s*armForegroundRepaint\(/);
	});

	it("repaints every surface, not just the focused one", () => {
		expect(mainCode).toMatch(
			/armForegroundRepaint\([\s\S]{0,200}?repaintAllInkOverlays\(\)/
		);
	});

	// FOREGROUND REPAINT ON DESKTOP (auditor, 2026-09-05): the call used to
	// hand in only `doc` and `win`, which is what let it register
	// unconditionally on every platform. Read from `codeOnly` output for the
	// same reason as the tests above it - a comment that merely discusses the
	// gate cannot make this pass for a call that does not wire it.
	it("gates registration on Platform.isMobileApp", () => {
		expect(mainCode).toMatch(
			/armForegroundRepaint\([\s\S]{0,200}?isMobileApp:\s*Platform\.isMobileApp/
		);
	});
});
