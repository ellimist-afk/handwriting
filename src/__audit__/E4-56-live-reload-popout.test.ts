/**
 * E4 probe for audit item 56 (finding ids L-compat-5, main-1-2,
 * L-lifecycle-7, L-multiview-9): live reload stops for popout windows
 * whenever the main window is minimized.
 *
 * Claim: the live-reload tick returns early on the bare `document.hidden`,
 * which in Obsidian desktop is always the main window's document. With the
 * main window minimized and a note or PDF open in a visible popout, no tick
 * checks anything, so another device's ink never arrives in the popout, and
 * the next local save there moves that ink into a conflict file.
 *
 * Production code driven: the real registered poll, sliced out of main.ts and
 * executed by src/testUtils/LiveReloadTestHarness.ts, as the sync suites do,
 * with the plugin's own pane census method on `this` (read off the prototype,
 * so this file loads before the method exists). A pane is either a PDF
 * controller whose root lives in a popout, or a note: an inline reload
 * binding (InkOverlay's census, stood in here) whose attachment lives in a
 * popout. Popouts are built by test/popoutWindow.ts; the `document` handed to
 * the poll is the main window's.
 *
 * Asserts the CORRECT behaviour: a visible popout PDF or note keeps the poll
 * checking while the main window is hidden. Controls: with every window
 * hidden the tick is skipped, and with the main window visible it checks even
 * when the only pane sits in a hidden popout (the main window holds embeds and
 * the slides deck).
 */
import { describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import { makePopoutWindow } from "../../test/popoutWindow";

const census = (HandwritingPlugin.prototype as unknown as Record<string, unknown>).reloadPanesHidden;

/** InkOverlay's inline pane census, stood in: one binding per note pane the cell opens. */
const inline = vi.hoisted(() => ({ bindings: [] as Array<{ attachment: { ownerDocument: unknown } }> }));
vi.mock("../inline/InkOverlay", async (importOriginal) => ({
	...(await importOriginal<object>()),
	inlineReloadBindings: () => inline.bindings,
}));

type Doc = { hidden: boolean };

function poll(mainDocument: Doc, panes: { pdf?: Doc; note?: Doc }) {
	let callback!: () => void;
	let pending = Promise.resolve();
	const stats: string[] = [];
	const pdfInk = new Map<object, object>();
	const pdfIds = new Map<object, string>();
	if (panes.pdf) {
		const root = { isConnected: true, ownerDocument: panes.pdf };
		pdfInk.set(root, { idle: true, refresh() {} });
		pdfIds.set(root, "pdf-1");
	}
	inline.bindings = panes.note ? [{ attachment: { ownerDocument: panes.note } }] : [];
	const state = {
		store: {
			externallyChanged: async (id: string) => {
				stats.push(id);
				return false;
			},
			hasQueuedWrite: () => false,
		},
		pdfStore: {},
		pdfInk,
		pdfIds,
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval() {},
		...(typeof census === "function" ? { reloadPanesHidden: census } : {}),
	};
	(installLiveReloadPoll as (...a: unknown[]) => void).call(
		state,
		{ setInterval: (fn: () => void) => ((callback = fn), 1) },
		mainDocument,
		(p: Promise<void>) => void (pending = p),
		() => [],
		{},
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error() {} },
		() => () => true
	);
	return {
		state,
		stats,
		async ticks(n: number) {
			for (let i = 0; i < n; i++) {
				callback();
				await pending;
			}
		},
	};
}

describe("E4 item 56 controls", () => {
	it("main window and popout both visible: the poll checks the popout's PDF", async () => {
		const popout = makePopoutWindow();
		const p = poll({ hidden: false }, { pdf: popout.document });
		await p.ticks(3);
		expect(p.state.pollStats.hidden).toBe(0);
		expect(p.stats.length).toBeGreaterThan(0);
	});

	it("every window hidden: the tick is skipped, nothing is checked", async () => {
		const popout = makePopoutWindow({ hidden: true });
		const p = poll({ hidden: true }, { pdf: popout.document, note: popout.document });
		await p.ticks(3);
		expect([p.state.pollStats.hidden, p.stats.length]).toEqual([3, 0]);
	});

	it("main window visible, the only pane in a hidden popout: the poll still runs", async () => {
		const popout = makePopoutWindow({ hidden: true });
		const p = poll({ hidden: false }, { note: popout.document });
		await p.ticks(3);
		expect(p.state.pollStats.hidden).toBe(0);
		expect(p.state.pollStats.checks).toBeGreaterThan(0);
	});
});

describe("E4 item 56 probe: a visible popout keeps live reload running", () => {
	it("main window minimized, PDF open in a visible popout: the poll still checks it", async () => {
		const popout = makePopoutWindow();
		const p = poll({ hidden: true }, { pdf: popout.document });
		await p.ticks(3);
		expect({ skippedHidden: p.state.pollStats.hidden, checked: p.stats.length > 0 }).toEqual({
			skippedHidden: 0,
			checked: true,
		});
	});

	it("main window minimized, note open in a visible popout, no PDF: the poll still runs", async () => {
		const popout = makePopoutWindow();
		const p = poll({ hidden: true }, { note: popout.document });
		await p.ticks(3);
		expect({ skippedHidden: p.state.pollStats.hidden, ran: p.state.pollStats.checks > 0 }).toEqual({
			skippedHidden: 0,
			ran: true,
		});
	});
});
