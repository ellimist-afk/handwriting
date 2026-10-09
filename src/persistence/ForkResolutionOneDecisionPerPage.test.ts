/**
 * Per-page decision concurrency and preserved kept-copy behavior.
 * Real decisions run over synthetic disk bytes, with the first decision held
 * at real I/O boundaries. Two hosts model two modals for different pairs.
 * No production plants or invented refusal strings are used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Modal: class { constructor(_app: unknown) {} },
	Notice: class { constructor(text: string) { notices.push(text); } },
}));
import { parsePage, serializePage, type PageData } from "../model/PageData";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { FakeAdapter, gate } from "./FakeAdapter";
import {
	applyForkDecision, forgetPair, listForks, recordFork, resetForks,
	type ForkHost, type ForkRecord,
} from "./ForkResolution";
import { ForkResolutionModal } from "./ForkResolutionModal";

const PAGE = "504fdb34-aed8-42a0-8df8-66f7db7a02de";
type Phase = "read" | "restore" | "verification" | "rename";
const changes = ["keep-mine", "take-theirs"] as const;
function page(pageId: string, strokeId: string): string {
	return JSON.stringify({ schemaVersion: 1, pageId, surface: "inline", textBoxes: [], images: [],
		strokes: [{ id: strokeId, tool: "pen", color: "#5f6673", width: 2.86, createdAt: 1700000000000,
			pts: [10, 20, 0.5, 0, 11, 21, 0.5, 1] }],
	});
}
function pair(token: string, pageId = PAGE): ForkRecord {
	return { pageId, path: "Demo/two devices.md", at: 1000,
		outgoingPath: `.handwriting/${pageId}.conflict-external-${token}-outgoing.json`,
		incomingPath: `.handwriting/${pageId}.conflict-external-${token}-incoming.json` };
}
function fixture(records: ForkRecord[]) {
	const disk = new FakeAdapter();
	for (const [i, rec] of records.entries()) {
		disk.externalWrite(rec.outgoingPath, page(rec.pageId, `mine-${i}`));
		disk.externalWrite(rec.incomingPath, page(rec.pageId, `theirs-${i}`));
		disk.externalWrite(`.handwriting/${rec.pageId}.json`, page(rec.pageId, "live-original"));
		recordFork(rec);
	}
	const events: Array<{ host: string; operation: string }> = [];
	function host(label: string, hook: (phase: Phase) => Promise<void> = async () => {}): ForkHost {
		async function save(id: string, data: PageData, operation: string) {
			events.push({ host: label, operation });
			await hook("restore");
			await disk.write(`.handwriting/${id}.json`, serializePage(data));
		}
		return {
			read: async (p) => {
				await hook(p.endsWith("-outgoing.json") || p.endsWith("-incoming.json") ? "read" : "verification");
				return disk.files.has(p) ? disk.read(p) : null;
			},
			stat: (p) => disk.stat(p),
			saveNow: (id, data) => save(id, data, "save"),
			restore: (id, data) => save(id, data, "restore"),
			rename: async (a, b) => {
				events.push({ host: label, operation: `rename ${a} to ${b}` });
				await hook("rename");
				await disk.rename(a, b);
			},
		};
	}
	return { disk, events, host };
}
function holdAt(phase: Phase) {
	const entered = gate(), held = gate();
	let used = false;
	return { entered: entered.promise, release: held.release,
		hook: async (p: Phase) => {
			if (p !== phase || used) return;
			used = true;
			entered.release();
			await held.promise;
		} };
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
/** FakeEl stores attributes separately; either form disables a real button. */
function buttonDisabled(button: FakeEl): boolean {
	return button.disabled || button.getAttribute("disabled") !== null;
}
beforeEach(() => { resetForks(); notices.length = 0; });

describe("one changing fork decision per page", () => {
	for (const phase of ["read", "restore", "verification", "rename"] as const) {
		for (const firstChoice of changes) {
			for (const secondChoice of changes) {
				it(`ignores ${secondChoice} on another pair while ${firstChoice} is held at ${phase}`, async () => {
					const firstPair = pair("first"), secondPair = pair("second");
					const v = fixture([firstPair, secondPair]);
					const held = holdAt(phase);
					const first = applyForkDecision(v.host("first", held.hook), firstPair, firstChoice);
					await held.entered;
					const before = [...v.disk.files.entries()];
					let settled = false;
					const second = applyForkDecision(v.host("second"), secondPair, secondChoice).then(() => { settled = true; });
					try {
						await flush();
						expect.soft(settled, "second decision completes without queueing").toBe(true);
						expect.soft(v.events.filter((e) => e.host === "second"), "no second write or rename").toEqual([]);
						expect.soft([...v.disk.files.entries()], "disk unchanged by second decision").toEqual(before);
						expect.soft(notices, "no notice for ignored decision").toEqual([]);
					} finally { held.release(); await Promise.all([first, second]); }
					expect.soft(v.events.filter((e) => e.host === "second"), "second decision never runs after release").toEqual([]);
					expect.soft(listForks(), "unanswered second pair stays listed").toContainEqual(secondPair);
				});
			}
		}
	}

	it("holds the page across the same pair in two hosts", async () => {
		const rec = pair("same"), v = fixture([rec]), held = holdAt("restore");
		const first = applyForkDecision(v.host("first", held.hook), rec, "keep-mine");
		await held.entered;
		let settled = false;
		const second = applyForkDecision(v.host("second"), rec, "take-theirs").then(() => { settled = true; });
		try {
			await flush();
			expect.soft(settled, "same-pair decision is not queued").toBe(true);
			expect.soft(v.events.filter((e) => e.host === "second")).toEqual([]);
		} finally { held.release(); await Promise.all([first, second]); }
	});

	it("lets another page decide while the first page is held", async () => {
		const firstPair = pair("first"), otherPair = pair("other", "another-page");
		const v = fixture([firstPair, otherPair]), held = holdAt("restore");
		const first = applyForkDecision(v.host("first", held.hook), firstPair, "keep-mine");
		await held.entered;
		try {
			const result = await applyForkDecision(v.host("other"), otherPair, "keep-mine");
			expect.soft(result.wrote).toBe(true);
			expect.soft(v.events.filter((e) => e.host === "other")).toHaveLength(3);
			expect.soft(parsePage(v.disk.files.get(`.handwriting/${otherPair.pageId}.json`)!, otherPair.pageId).data.strokes[0]!.id).toBe("mine-1");
		} finally { held.release(); await first; }
	});

	it("keep-both has no guard and performs no I/O while the page is held", async () => {
		const firstPair = pair("first"), secondPair = pair("second"), v = fixture([firstPair, secondPair]);
		const held = holdAt("restore"), first = applyForkDecision(v.host("first", held.hook), firstPair, "keep-mine");
		await held.entered;
		try {
			const host = v.host("both");
			host.read = async () => { throw new Error("Keep both must not read"); };
			const result = await applyForkDecision(host, secondPair, "keep-both");
			expect.soft(result).toEqual({ kind: "applied", wrote: false, stillListed: true });
			expect.soft(v.events.filter((e) => e.host === "both")).toEqual([]);
			expect.soft(listForks()).toContainEqual(secondPair);
		} finally { held.release(); await first; }
	});

	it.each(changes)("does nothing for unlisted pair: %s", async (choice) => {
		const stale = pair("stale"), current = pair("current"), v = fixture([stale, current]);
		forgetPair(stale);
		const before = [...v.disk.files.entries()];
		await applyForkDecision(v.host("stale"), stale, choice);
		expect.soft(v.events, "no write or rename").toEqual([]);
		expect.soft([...v.disk.files.entries()], "bytes unchanged").toEqual(before);
		expect.soft(listForks()).toEqual([current]);
		expect.soft(notices).toEqual([]);
	});
});

describe("fork decisions that stay as they were", () => {
	it.each(["property", "attribute"] as const)("recognizes disabled %s and an enabled sibling", (form) => {
		const doc = new FakeDoc();
		const disabled = new FakeEl("button", doc), enabled = new FakeEl("button", doc);
		if (form === "property") disabled.disabled = true;
		else disabled.setAttribute("disabled", "true");
		expect.soft(buttonDisabled(disabled), "valid disabled form").toBe(true);
		expect.soft(buttonDisabled(enabled), "enabled sibling").toBe(false);
	});

	it.each(changes)("kept copy retains existing %s behavior", async (choice) => {
		const rec: ForkRecord = { ...pair("kept"), kept: true,
			outgoingPath: `.handwriting/${PAGE}.json`, incomingPath: `.handwriting/${PAGE}.conflict-1700000000000.json` };
		const v = fixture([rec]);
		v.disk.externalWrite(rec.outgoingPath, page(PAGE, "live-mine"));
		const keptBytes = v.disk.files.get(rec.incomingPath)!;
		const result = await applyForkDecision(v.host("kept"), rec, choice);
		expect.soft(result.kind).toBe("applied");
		expect.soft(result.wrote).toBe(choice === "take-theirs");
		expect.soft(parsePage(v.disk.files.get(rec.outgoingPath)!, PAGE).data.strokes[0]!.id).toBe(choice === "keep-mine" ? "live-mine" : "theirs-0");
		expect.soft(v.disk.files.get(rec.incomingPath.replace(".conflict-", ".conflict-resolved-"))).toBe(keptBytes);
		expect.soft(v.disk.files.has(rec.outgoingPath), "live filename never renamed").toBe(true);
		expect.soft(notices).toEqual([]);
	});

	it("disables all three buttons for the modal pair during its decision", async () => {
		const rec = pair("buttons"), v = fixture([rec]), held = holdAt("restore");
		const modal = new ForkResolutionModal({} as never, v.host("modal", held.hook));
		const content = new FakeEl("div", new FakeDoc());
		(modal as unknown as { contentEl: FakeEl }).contentEl = content;
		await modal.onOpen();
		function buttons(el: FakeEl): FakeEl[] {
			return [...el.children].flatMap((child) => child.tagName === "button" ? [child as FakeEl] : buttons(child as FakeEl));
		}
		const actions = buttons(content);
		expect(actions).toHaveLength(3);
		actions[0]!.fire("click");
		await held.entered;
		try { for (const action of actions) expect.soft(buttonDisabled(action), action.textContent).toBe(true); }
		finally { held.release(); await flush(); }
	});
});
