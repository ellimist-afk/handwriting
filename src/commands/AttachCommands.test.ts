/**
 * The lasso's two palette commands for attached ink: "Lasso: attach ink to text" and "Lasso: detach ink from text".
 * Listed only on a note, only while the selection allows each (the selection's chip state); running one calls the
 * overlay's own action. Attach that finds no text under the ink says so. On a bare plugin with a stub surface.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, Notice: class { constructor(message: string) { notices.push(message); } } };
});

import { HandwritingPlugin } from "../main";
import { inlineInk } from "../inline/InkOverlayRegistry";
import { attachmentMembership, targetAt, type AttachmentRecord } from "../inline/InkAttachments";
import { ATTACH_STRINGS } from "../inline/AttachDecoration";

type Command = { id: string; name: string; checkCallback(checking: boolean): boolean };
const PATH = "attach-commands.md";
const DOC = "first line words";
const group: AttachmentRecord = { v: 1, id: "g1", strokeIds: ["a", "b"], target: targetAt(DOC, 0, 10, "paragraph"), ref: { x: 0, y: 0 }, layout: { width: 900, font: 16 }, probe: { id: "a", x: 0, y: 0 } };

function rig(selected: string[], surfaceKind: "inline" | "pdf" | null = "inline", attachWorks = true, list: AttachmentRecord[] = [group]) {
	const rec = inlineInk.record(PATH);
	rec.attachments = list;
	const calls: string[] = [];
	let revision = 0;
	const overlay = {
		filePath: () => PATH,
		lineAnchors: { follow: { setList: () => {}, memberMap: attachmentMembership(list) } },
		selection: { strokeIds: selected, revision: ++revision, isEmpty: selected.length === 0 },
		attachSelected: () => (calls.push("attach"), attachWorks),
		detachSelected: () => (calls.push("detach"), true),
		openAttachPick: () => void calls.push("pick"),
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as { addCommand(c: Command): Command; registerExportSelectionCommands(): void; activeInkSurface(): unknown };
	const commands = new Map<string, Command>();
	plugin.addCommand = (c) => (commands.set(c.id, c), c);
	plugin.activeInkSurface = () => (surfaceKind === "inline" ? { kind: "inline", overlay } : surfaceKind === "pdf" ? { kind: "pdf", controller: {} } : null);
	plugin.registerExportSelectionCommands();
	return { attach: commands.get("attach-ink-to-text")!, detach: commands.get("detach-ink")!, calls };
}

describe("Lasso: attach ink to text / detach ink from text", () => {
	beforeEach(() => void (notices.length = 0));

	it("are registered under those names", () => {
		const r = rig([]);
		expect([r.attach.name, r.detach.name]).toEqual(["Lasso: attach ink to text", "Lasso: detach ink from text"]);
	});

	it("are listed only while the selection allows each: the chip table", () => {
		const listed = (ids: string[]) => { const r = rig(ids); return [r.attach.checkCallback(true), r.detach.checkCallback(true)]; };
		expect(listed([]), "nothing selected").toEqual([false, false]);
		expect(listed(["free"]), "free ink").toEqual([true, false]);
		expect(listed(["a", "b"]), "one whole group").toEqual([true, true]);
		expect(listed(["a", "free"]), "a group and free ink").toEqual([true, false]);
	});

	it("Detach is listed on a lasso over two groups, loose ink in it or not, and runs the overlay's Detach; Attach is not", () => {
		// Defect: the palette hides Detach for two groups while the button shows it.
		const two: AttachmentRecord[] = [group, { ...group, id: "g2", strokeIds: ["c"], probe: { id: "c", x: 0, y: 0 } }];
		for (const ids of [["a", "c"], ["a", "c", "free"]]) {
			const r = rig(ids, "inline", true, two);
			expect([r.attach.checkCallback(true), r.detach.checkCallback(true)], ids.join(" ")).toEqual([false, true]);
			r.detach.checkCallback(false);
			expect(r.calls, ids.join(" ")).toEqual(["detach"]);
		}
	});

	it("are not listed on a pdf or with no ink surface", () => {
		for (const kind of ["pdf", null] as const) {
			const r = rig(["a", "b"], kind);
			expect([r.attach.checkCallback(true), r.detach.checkCallback(true)], String(kind)).toEqual([false, false]);
		}
	});

	it("run the overlay's own Attach and Detach and nothing more, no pick window; checking runs nothing", () => {
		// Defect (1.5.0): Attach opens the timed pick window after it; the pin replaces the pick.
		const r = rig(["a", "b"]);
		r.attach.checkCallback(true);
		r.detach.checkCallback(true);
		expect(r.calls).toEqual([]);
		r.attach.checkCallback(false);
		r.detach.checkCallback(false);
		expect(r.calls).toEqual(["attach", "detach"]);
		expect(notices).toEqual([]);
	});

	it("Attach with no text under the ink says so and attaches nothing", () => {
		const r = rig(["free"], "inline", false);
		r.attach.checkCallback(false);
		expect(notices).toEqual([ATTACH_STRINGS.noText]);
	});
});
