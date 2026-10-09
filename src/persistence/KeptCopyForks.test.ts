/**
 * Copies kept beside a live page: what the fork screen says about them, and
 * that no decision loses one.
 *
 * A kept copy records no writer, so which side is this device's cannot be
 * told on every device: both sides read Version A (the page as it is now) and
 * Version B (the copy). A copy this build cannot read - a newer build's
 * stroke, a newer schema - is still listed, its side reads "cannot be read",
 * and neither keep button retires it. A copy the ink-folder move kept aside
 * is a kept copy like any other.
 *
 * The real scan, decision and modal run over synthetic disk bytes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Modal: class { constructor(_app: unknown) {} },
	Notice: class { constructor(text: string) { notices.push(text); } },
}));
import { serializePage, type PageData } from "../model/PageData";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { FakeAdapter } from "./FakeAdapter";
import {
	FORK_COPY_PLACEHOLDER as COPY,
	recordFork, resetForks, scanForForks,
	type ForkHost,
} from "./ForkResolution";
import { ForkResolutionModal } from "./ForkResolutionModal";

const PAGE = "3b7d9e21-0c4a-4f6e-8a15-2d9c7b4e6f80";
const FOLDER = ".handwriting";
const live = `${FOLDER}/${PAGE}.json`;
const guardCopy = `${FOLDER}/${PAGE}.conflict-1700000000000.json`;
const moveCopy = `${FOLDER}/${PAGE}.conflict-migration-1700000000123.json`;

const strokeOf = (id: string) => ({ id, tool: "pen", color: "#5f6673", width: 2.86, createdAt: 1700000000000,
	pts: [10, 20, 0.5, 0, 11, 21, 0.5, 1] });
function page(...ids: string[]): string {
	return JSON.stringify({ schemaVersion: 1, pageId: PAGE, surface: "inline", textBoxes: [], images: [], strokes: ids.map(strokeOf) });
}
/** A page whose one stroke keeps its points under a key this build does not know. */
const newerBuildStroke = JSON.stringify({ schemaVersion: 1, pageId: PAGE, surface: "inline", textBoxes: [], images: [],
	strokes: [{ id: "from-a-newer-build", tool: "pen", color: "#5f6673", width: 2.86, createdAt: 1700000000000, ptsNext: [1, 2, 3] }] });
/** A page declaring a schema newer than this build. */
const newerSchema = JSON.stringify({ ...JSON.parse(page("newer-schema-ink")), schemaVersion: 99 });

function vault(files: Record<string, string>) {
	const disk = new FakeAdapter();
	for (const [p, text] of Object.entries(files)) disk.externalWrite(p, text);
	const reads: string[] = [];
	const writes: string[] = [];
	const host: ForkHost = {
		deviceId: "device-here",
		read: async (p) => { reads.push(p); return disk.files.has(p) ? disk.read(p) : null; },
		stat: (p) => disk.stat(p),
		list: async () => [...disk.files.keys()].map((p) => p.slice(p.lastIndexOf("/") + 1)),
		saveNow: async (id: string, data: PageData) => { writes.push(id); await disk.write(`${FOLDER}/${id}.json`, serializePage(data)); },
		restore: async (id: string, data: PageData) => { writes.push(id); await disk.write(`${FOLDER}/${id}.json`, serializePage(data)); },
		rename: async (a, b) => { writes.push(`rename ${a}`); await disk.rename(a, b); },
	};
	return { disk, host, reads, writes };
}

async function openScreen(host: ForkHost) {
	for (const rec of await scanForForks(host, FOLDER)) recordFork(rec);
	const modal = new ForkResolutionModal({} as never, host);
	const content = new FakeEl("div", new FakeDoc());
	(modal as unknown as { contentEl: FakeEl }).contentEl = content;
	await modal.onOpen();
	const all = (el: FakeEl): FakeEl[] => [...el.children].flatMap((c) => [c as FakeEl, ...all(c as FakeEl)]);
	const els = all(content);
	const buttons = els.filter((e) => e.tagName === "button");
	const lines = els.filter((e) => e.tagName === "p").map((e) => e.textContent);
	return { buttons, lines, texts: buttons.map((b) => b.textContent), forks: els.filter((e) => e.tagName === "h3").length };
}

async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

async function press(button: FakeEl): Promise<string[]> {
	notices.length = 0;
	button.fire("click");
	await settle();
	await settle();
	return [...notices];
}

beforeEach(() => { resetForks(); notices.length = 0; });

describe("a kept copy names its sides Version A and Version B", () => {
	it("a copy the save guard kept: sides and buttons read Version A and Version B", async () => {
		const v = vault({ [live]: page("on-the-page"), [guardCopy]: page("only-in-the-copy") });
		const s = await openScreen(v.host);
		expect(s.lines.filter((l) => /^Version [AB]: /.test(l)).map((l) => l.slice(0, 10)), "a kept copy's sides still claim a device").toEqual([
			"Version A:",
			"Version B:",
		]);
		expect(s.texts).toEqual(["Keep Version A", "Keep Version B", "Keep both"]);
		expect(s.lines.find((l) => l.startsWith("Version A:")), "Version A is not the page as it is now").toMatch(/^Version A: 1 strokes, 1 not in the other/);
	});

	it("Keep Version A keeps the page as it is and retires only the copy, still on disk", async () => {
		const v = vault({ [live]: page("on-the-page"), [guardCopy]: page("only-in-the-copy") });
		const before = v.disk.files.get(live);
		const s = await openScreen(v.host);
		expect(s.texts[0], "precondition: the first button keeps Version A").toBe("Keep Version A");
		await press(s.buttons[0]!);
		expect(v.disk.files.get(live), "the live page changed").toBe(before);
		expect(v.disk.files.has(`${FOLDER}/${PAGE}.conflict-resolved-1700000000000.json`), "the copy is not kept under its resolved name").toBe(true);
	});
});

describe("a kept copy this build cannot read is listed and never retired", () => {
	for (const [name, bytes] of [
		["a newer build's stroke", newerBuildStroke],
		["a newer schema", newerSchema],
	] as const) {
		it(`${name}: listed, its side reads "${COPY.unreadable}"`, async () => {
			const v = vault({ [live]: page("on-the-page"), [guardCopy]: bytes });
			const s = await openScreen(v.host);
			expect(s.forks, "the copy is not listed").toBe(1);
			expect(s.lines, "its side does not say it cannot be read").toContain(`Version B: ${COPY.unreadable}`);
		});

		it(`${name}: both keeps are refused before any read, write or rename, and the copy stays listed`, async () => {
			const v = vault({ [live]: page("on-the-page"), [guardCopy]: bytes });
			const s = await openScreen(v.host);
			expect(s.texts, "precondition: listed with both keeps").toEqual(["Keep Version A", "Keep Version B", "Keep both"]);
			const filesBefore = [...v.disk.files.entries()];
			v.reads.length = 0;
			expect(await press(s.buttons[0]!), "keep A on a copy this build cannot read").toEqual(["Could not keep Version A"]);
			expect(await press(s.buttons[1]!), "keep B on a copy this build cannot read").toEqual(["Could not keep Version B"]);
			expect(v.reads.filter((p) => p === live), "the live page was read for a refused decision").toEqual([]);
			expect(v.writes, "a refused decision wrote or renamed").toEqual([]);
			expect([...v.disk.files.entries()], "the disk changed").toEqual(filesBefore);
			const again = await openScreen(v.host);
			expect(again.forks, "the copy is no longer listed").toBe(1);
		});
	}

	it("a copy that is gone is not listed", async () => {
		const v = vault({ [live]: page("on-the-page"), [guardCopy]: page("only-in-the-copy") });
		for (const rec of await scanForForks(v.host, FOLDER)) recordFork(rec);
		await v.disk.remove(guardCopy);
		const modal = new ForkResolutionModal({} as never, v.host);
		const content = new FakeEl("div", new FakeDoc());
		(modal as unknown as { contentEl: FakeEl }).contentEl = content;
		await modal.onOpen();
		expect([...content.children].some((c) => (c as FakeEl).tagName === "div"), "a copy that is gone was listed").toBe(false);
	});

	it("a copy this build cannot read does not take the place of a readable one on the same page", async () => {
		const pairOut = `${FOLDER}/${PAGE}.conflict-external-t1-outgoing.json`;
		const pairIn = `${FOLDER}/${PAGE}.conflict-external-t1-incoming.json`;
		const v = vault({
			[live]: page("on-the-page"),
			[pairOut]: JSON.stringify({ ...JSON.parse(page("mine-only")), "handwriting:adoptedBy": "device-here" }),
			[pairIn]: page("theirs-only"),
		});
		// The unreadable copy is the newest file for the page.
		v.disk.externalWrite(guardCopy, newerBuildStroke);
		const s = await openScreen(v.host);
		expect(s.texts, "the readable fork was hidden by the one that cannot be read").toEqual(
			expect.arrayContaining([COPY.keepMine, COPY.takeTheirs])
		);
		expect(s.forks, "both are not listed").toBe(2);
		expect(s.lines, "the copy that cannot be read is not listed").toContain(`Version B: ${COPY.unreadable}`);
	});

	it("a copy this build cannot read that is older than a readable one on the same page is still listed beside it", async () => {
		const pairOut = `${FOLDER}/${PAGE}.conflict-external-t1-outgoing.json`;
		const pairIn = `${FOLDER}/${PAGE}.conflict-external-t1-incoming.json`;
		// The unreadable copy is written first, so the readable pair is newer
		// and is described before it.
		const v = vault({ [live]: page("on-the-page"), [guardCopy]: newerBuildStroke });
		v.disk.externalWrite(pairOut, JSON.stringify({ ...JSON.parse(page("mine-only")), "handwriting:adoptedBy": "device-here" }));
		v.disk.externalWrite(pairIn, page("theirs-only"));
		expect(
			(await v.disk.stat(guardCopy))!.mtime < (await v.disk.stat(pairIn))!.mtime,
			"precondition: the copy that cannot be read is older than the pair"
		).toBe(true);
		const s = await openScreen(v.host);
		expect(s.texts, "the readable fork is not offered").toEqual(expect.arrayContaining([COPY.keepMine, COPY.takeTheirs]));
		expect(s.forks, "both are not listed").toBe(2);
		expect(s.lines, "the older copy that cannot be read is not listed").toContain(`Version B: ${COPY.unreadable}`);
	});
});

describe("a copy the ink-folder move kept aside is a kept copy", () => {
	it("listed with Version A and Version B", async () => {
		const v = vault({ [live]: page("on-the-page"), [moveCopy]: page("only-in-the-moved-copy") });
		const s = await openScreen(v.host);
		expect(s.forks, "the move's copy is not listed").toBe(1);
		expect(s.texts).toEqual(["Keep Version A", "Keep Version B", "Keep both"]);
	});

	it("Keep Version A retires it under its own resolved name, which no scan lists", async () => {
		const v = vault({ [live]: page("on-the-page"), [moveCopy]: page("only-in-the-moved-copy") });
		const before = v.disk.files.get(live);
		const s = await openScreen(v.host);
		expect(s.texts[0], "precondition: listed").toBe("Keep Version A");
		await press(s.buttons[0]!);
		expect(v.disk.files.get(live), "the live page changed").toBe(before);
		expect(v.disk.files.has(`${FOLDER}/${PAGE}.conflict-resolved-migration-1700000000123.json`), "not kept under its resolved name").toBe(true);
		expect(v.disk.files.has(moveCopy)).toBe(false);
		resetForks();
		expect(await scanForForks(v.host, FOLDER), "the retired copy is listed again").toEqual([]);
	});
});
