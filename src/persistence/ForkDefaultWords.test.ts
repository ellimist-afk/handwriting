/**
 * The fork screen's words where Alan's ten cannot be true or do not fit.
 *
 * A pair this device cannot place - no writer recorded on it, or no device id
 * on this install - cannot say which side is this device's, so it names its
 * sides Version A and Version B. A refused "take the other" says so instead of
 * borrowing the keep-mine words. Everything else keeps his ten.
 *
 * The real scan, the real decision and the real modal run over synthetic disk
 * bytes. A decision is refused by a restore that throws, the way a copy that
 * cannot be made refuses one on a device.
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
	type ForkHost, type ForkRecord,
} from "./ForkResolution";
import { ForkResolutionModal } from "./ForkResolutionModal";
import { ADOPTED_BY_KEY } from "./PageStore";

const PAGE = "6f1c2a90-5d3e-4b7a-9c21-0e8f4d6b3a17";
const FOLDER = ".handwriting";
const THIS_DEVICE = "device-here";

function page(strokeId: string, writer?: string): string {
	const text = JSON.stringify({ schemaVersion: 1, pageId: PAGE, surface: "inline", textBoxes: [], images: [],
		strokes: [{ id: strokeId, tool: "pen", color: "#5f6673", width: 2.86, createdAt: 1700000000000,
			pts: [10, 20, 0.5, 0, 11, 21, 0.5, 1] }],
	});
	if (writer === undefined) return text;
	return JSON.stringify({ ...JSON.parse(text), [ADOPTED_BY_KEY]: writer });
}

const outgoing = `${FOLDER}/${PAGE}.conflict-external-t1-outgoing.json`;
const incoming = `${FOLDER}/${PAGE}.conflict-external-t1-incoming.json`;
const live = `${FOLDER}/${PAGE}.json`;

/**
 * A vault holding one fork for PAGE. `writer` is what the outgoing leg records
 * (undefined: nothing recorded); `kept` lays it out as a copy the save guard
 * kept instead of an adoption pair.
 */
function vault(opts: { writer?: string; kept?: boolean; deviceId?: string | null }) {
	const disk = new FakeAdapter();
	if (opts.kept) {
		disk.externalWrite(live, page("mine-only"));
		disk.externalWrite(`${FOLDER}/${PAGE}.conflict-1700000000000.json`, page("theirs-only"));
	} else {
		disk.externalWrite(outgoing, page("mine-only", opts.writer));
		disk.externalWrite(incoming, page("theirs-only"));
		disk.externalWrite(live, page("live-original"));
	}
	const host: ForkHost = {
		...(opts.deviceId === null ? {} : { deviceId: opts.deviceId ?? THIS_DEVICE }),
		read: async (p) => (disk.files.has(p) ? disk.read(p) : null),
		stat: (p) => disk.stat(p),
		list: async () => [...disk.files.keys()].map((p) => p.slice(p.lastIndexOf("/") + 1)),
		saveNow: async (id: string, data: PageData) => { await disk.write(`${FOLDER}/${id}.json`, serializePage(data)); },
		// Every decision that would change the live page is refused here.
		restore: async () => { throw new Error("the copy of the current page could not be made"); },
		rename: (a, b) => disk.rename(a, b),
	};
	return { disk, host };
}

/** Scan as the command does, register what it found, and open the screen. */
async function openScreen(host: ForkHost, records?: ForkRecord[]) {
	for (const rec of records ?? (await scanForForks(host, FOLDER))) recordFork(rec);
	const modal = new ForkResolutionModal({} as never, host);
	const content = new FakeEl("div", new FakeDoc());
	(modal as unknown as { contentEl: FakeEl }).contentEl = content;
	await modal.onOpen();
	const all = (el: FakeEl): FakeEl[] => [...el.children].flatMap((c) => [c as FakeEl, ...all(c as FakeEl)]);
	const els = all(content);
	const buttons = els.filter((e) => e.tagName === "button");
	const lines = els.filter((e) => e.tagName === "p").map((e) => e.textContent);
	return { buttons, lines, texts: buttons.map((b) => b.textContent) };
}

async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

/** Press one button and return the notice it left. */
async function press(button: FakeEl): Promise<string[]> {
	notices.length = 0;
	button.fire("click");
	await vi.waitFor(() => expect(notices.length).toBeGreaterThan(0));
	await settle();
	return [...notices];
}

beforeEach(() => { resetForks(); notices.length = 0; });

describe("a refused take-the-other names what was refused", () => {
	it("on a pair this device wrote, take-the-other refused says it could not take the other device's ink", async () => {
		const v = vault({ writer: THIS_DEVICE });
		const s = await openScreen(v.host);
		expect(s.texts, "precondition: his three buttons").toEqual([COPY.keepMine, COPY.takeTheirs, COPY.keepBoth]);
		expect(await press(s.buttons[1]!), "the refused take-the-other showed the keep-mine words").toEqual([
			"Could not take the other device's ink",
		]);
	});

	it("on a pair this session saw arrive, take-the-other refused says the same", async () => {
		const v = vault({ writer: THIS_DEVICE });
		const s = await openScreen(v.host, [{ pageId: PAGE, path: "Demo/two devices.md", at: 1000, outgoingPath: outgoing, incomingPath: incoming }]);
		expect(await press(s.buttons[1]!), "the refused take-the-other showed the keep-mine words").toEqual([
			"Could not take the other device's ink",
		]);
	});

	it("keep-mine refused still shows his words", async () => {
		const v = vault({ writer: THIS_DEVICE });
		const s = await openScreen(v.host);
		expect(await press(s.buttons[0]!)).toEqual([COPY.refused]);
	});
});

describe("a pair this device cannot place names its sides Version A and Version B", () => {
	for (const [name, opts] of [
		["no writer recorded on it", { writer: undefined }],
		["no device id on this install", { writer: "device-elsewhere", deviceId: null }],
	] as const) {
		it(`${name}: the sides and buttons read Version A and Version B`, async () => {
			const v = vault(opts);
			const s = await openScreen(v.host);
			expect(s.lines.filter((l) => /^Version [AB]: /.test(l)).map((l) => l.slice(0, 10)), "the sides still claim a device").toEqual([
				"Version A:",
				"Version B:",
			]);
			expect(s.lines.some((l) => l.startsWith(`${COPY.mine}:`) || l.startsWith(`${COPY.theirs}:`)), "a side still names a device").toBe(false);
			expect(s.texts, "the buttons still claim a device").toEqual(["Keep Version A", "Keep Version B", "Keep both"]);
		});

		it(`${name}: a refused keep names the version`, async () => {
			const v = vault(opts);
			const s = await openScreen(v.host);
			expect(await press(s.buttons[0]!), "keep A refused").toEqual(["Could not keep Version A"]);
			expect(await press(s.buttons[1]!), "keep B refused").toEqual(["Could not keep Version B"]);
		});
	}

	it("Version A is the outgoing leg as it lies on disk: its side line counts the outgoing leg's stroke", async () => {
		const v = vault({ writer: undefined });
		await v.disk.write(outgoing, JSON.stringify({ ...JSON.parse(page("a")), strokes: [
			...JSON.parse(page("a")).strokes, { ...JSON.parse(page("a2")).strokes[0] },
		] }));
		const s = await openScreen(v.host);
		expect(s.lines.find((l) => l.startsWith("Version A:")), "Version A is not the outgoing leg").toMatch(/^Version A: 2 strokes/);
		expect(s.lines.find((l) => l.startsWith("Version B:"))).toMatch(/^Version B: 1 strokes/);
	});
});

describe("pairs this device can place keep his words", () => {
	for (const [name, opts] of [
		["a pair this device wrote", { writer: THIS_DEVICE }],
		["a pair the other device wrote", { writer: "device-elsewhere" }],
	] as const) {
		it(`${name}: his side labels and buttons`, async () => {
			const v = vault(opts);
			const s = await openScreen(v.host);
			expect(s.lines.filter((l) => l.startsWith(`${COPY.mine}:`) || l.startsWith(`${COPY.theirs}:`)).length).toBe(2);
			expect(s.texts).toEqual([COPY.keepMine, COPY.takeTheirs, COPY.keepBoth]);
		});
	}
});

describe("a copy the save guard kept cannot be placed either", () => {
	it("a copy the save guard kept: Version A and Version B, not his device labels", async () => {
		const v = vault({ kept: true });
		const s = await openScreen(v.host);
		expect(s.lines.some((l) => l.startsWith(`${COPY.mine}:`) || l.startsWith(`${COPY.theirs}:`)), "a kept copy's side still names a device").toBe(false);
		expect(s.texts).toEqual(["Keep Version A", "Keep Version B", "Keep both"]);
	});
});
