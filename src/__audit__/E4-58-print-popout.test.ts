/**
 * E4 probe for audit item 58 (1.4.21 audit, finding ids EmbedFold-8,
 * L-lifecycle-6): print listeners keep every closed popout window in memory
 * until plugin unload.
 *
 * Claim: attachEmbedInk arms the print swap on the root's own window
 * (EmbedInk.ts armPrintSwap). Each arm pushes closures that hold that Window
 * into the module-level printDisarms, and the only thing that empties it is
 * disarmPrintSwaps at plugin unload (main.ts). So a popout that rendered an
 * inked embed stays referenced after it closes, with its beforeprint,
 * afterprint and print media listeners still on it.
 *
 * Production code driven: the real attachEmbedInk, armPrintSwap and
 * disarmPrintSwaps. The popout is test/popoutWindow.ts: its own window and
 * document, every listener add and remove recorded, and a close that fires
 * beforeunload, pagehide and unload.
 *
 * How retention is seen without a heap: after the popout closes, the module
 * is told to drop everything it holds (disarmPrintSwaps, the plugin's own
 * unload). A module that still held the closed window reaches into it then,
 * and the harness records those calls as `afterClose`. A module that let the
 * window go makes none.
 *
 * The probe cell states the CORRECT behaviour. It was red at 7a2a9d06 (gated
 * behind HANDWRITING_E4_PROBES=1 until the fix landed) and runs always now.
 * The two controls prove the harness sees the listeners at all, so a green
 * probe cannot come from a harness that sees nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { attachEmbedInk, disarmPrintSwaps, teardownEmbedInk } from "../inline/EmbedInk";
import { makePopoutWindow, PopoutWindow } from "../../test/popoutWindow";

/** The smallest root attachEmbedInk and a zero-stroke paint touch (as in EmbedInkReady.test.ts). */
function rootIn(popout: PopoutWindow) {
	const attrs = new Map<string, string>();
	return {
		isConnected: true,
		classList: { contains: () => false },
		style: { position: "", removeProperty(): void {} },
		querySelector: () => null,
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		ownerDocument: popout.document,
	} as unknown as HTMLElement;
}

/** Every listener still on the popout, by type, window and media lists together. */
function live(popout: PopoutWindow) {
	return {
		beforeprint: popout.listeners("beforeprint"),
		afterprint: popout.listeners("afterprint"),
		printMedia: popout.mediaListeners("print"),
		unload: popout.listeners("unload"),
		beforeunload: popout.listeners("beforeunload"),
		pagehide: popout.listeners("pagehide"),
	};
}

const none = { beforeprint: 0, afterprint: 0, printMedia: 0, unload: 0, beforeunload: 0, pagehide: 0 };

afterEach(() => {
	disarmPrintSwaps();
	teardownEmbedInk();
});

describe("E4 item 58 controls: the harness sees the print listeners", () => {
	it("an embed rendered in a popout arms print on that popout, and plugin unload takes it all off", () => {
		const popout = makePopoutWindow();
		attachEmbedInk(rootIn(popout), "note.md", []);

		expect([popout.listeners("beforeprint"), popout.listeners("afterprint"), popout.mediaListeners("print")]).toEqual([1, 1, 1]);

		disarmPrintSwaps();
		// Nothing of ours may be left on a live window after unload, including
		// whatever a fix adds to notice the close.
		expect(live(popout)).toEqual(none);
	});

	it("a second embed in the same popout does not arm it twice", () => {
		const popout = makePopoutWindow();
		attachEmbedInk(rootIn(popout), "a.md", []);
		attachEmbedInk(rootIn(popout), "b.md", []);

		expect([popout.listeners("beforeprint"), popout.listeners("afterprint"), popout.mediaListeners("print")]).toEqual([1, 1, 1]);
	});
});

describe("E4 item 58: a window that outlives its pagehide", () => {
	it("arms print again at its next embed", () => {
		const popout = makePopoutWindow();
		attachEmbedInk(rootIn(popout), "note.md", []);
		popout.dispatch("pagehide");
		expect(popout.listeners("beforeprint")).toBe(0);
		attachEmbedInk(rootIn(popout), "note.md", []);
		expect([popout.listeners("beforeprint"), popout.listeners("afterprint"), popout.mediaListeners("print")]).toEqual([1, 1, 1]);
	});
});

describe("E4 item 58 probe", () => {
	it("a closed popout is let go: nothing left on it, and plugin unload never reaches back into it", () => {
		const popout = makePopoutWindow();
		attachEmbedInk(rootIn(popout), "note.md", []);

		popout.close();
		const leftOnClosedWindow = live(popout);
		disarmPrintSwaps();
		const touchedAfterClose = popout.calls.filter((c) => c.afterClose);

		expect({ leftOnClosedWindow, touchedAfterClose }).toEqual({ leftOnClosedWindow: none, touchedAfterClose: [] });
	});
});
