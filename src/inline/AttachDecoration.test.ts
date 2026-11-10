/**
 * Attached ink on screen: chip states, the outline, the labels and the tag, the tap that narrows two groups to one, the
 * mark on the target's text, and the one table of words. Pure functions and a bare EditorState: no DOM, no layout.
 */
import { describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, Notice: class { constructor(message: string) { notices.push(message); } } };
});

import * as decoration from "./AttachDecoration";
import { EditorState } from "@codemirror/state";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { attachmentMembership, attachmentSelection, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import {
	ATTACH_STRINGS, NO_CHROME, attachChrome, attachTargetField, chipState, drawAttachChrome, groupAt, groupBoxes, selectionChips, setAttachTarget, toggleAttach,
	type ChromeTail, type GroupBox,
} from "./AttachDecoration";
import decorationSrc from "./AttachDecoration.ts?raw";
import css from "../../styles.css?raw";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOC = "first line words\nsecond line words\nthird line words";

function stroke(id: string, x: number, y: number, w = 20, h = 10): InkStroke {
	const points = [{ x, y, pressure: 0.5, t: 0 }, { x: x + w, y: y + h, pressure: 0.5, t: 1 }];
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 0), createdAt: 1 };
}

function group(id: string, strokeIds: string[]): AttachmentRecord {
	return { v: 1, id, strokeIds, target: targetAt(DOC, 0, 16, "paragraph"), ref: { x: 0, y: 0 }, layout: { width: 900, font: 16 }, probe: { id: strokeIds[0]!, x: 0, y: 0 } };
}

const LIST: AttachmentData[] = [group("g1", ["a", "b"]), group("g2", ["c"])];

describe("chip states: the follow's kept map gives attachmentSelection's answer", () => {
	const cases: Array<[string, string[]]> = [
		["nothing selected", []],
		["free ink only", ["free"]],
		["one whole group", ["a", "b"]],
		["one member of a group", ["a"]],
		["a group and free ink", ["a", "b", "free"]],
		["two groups", ["a", "c"]],
		["two groups and free ink", ["a", "c", "free"]],
	];
	const map = attachmentMembership(LIST);
	for (const [name, ids] of cases) {
		it(name, () => {
			const want = attachmentSelection(LIST, ids), got = chipState(map, ids);
			expect({ attach: got.attach, detach: got.detach, groupIds: got.groupIds }).toEqual({ attach: want.attach, detach: want.detach, groupIds: want.groupIds });
		});
	}

	it("the plan's table: one group Detach on; group plus free ink Attach on, Detach off; two groups Detach on, Attach off", () => {
		expect(chipState(map, ["a", "b"])).toMatchObject({ attach: true, detach: true });
		expect(chipState(map, ["a", "free"])).toMatchObject({ attach: true, detach: false });
		expect(chipState(map, ["a", "c"])).toMatchObject({ attach: false, detach: true });
		expect(chipState(map, ["a", "c", "free"]), "loose ink in the lasso").toMatchObject({ attach: false, detach: true });
	});

	it("selectionChips keeps its answer while the selection and the membership hold, and none with nothing selected", () => {
		let sets = 0;
		const sel = { strokeIds: ["a", "b"], revision: 1, isEmpty: false };
		const surface = { filePath: () => "n.md", lineAnchors: { follow: { setList: () => void sets++, memberMap: map } }, selection: sel };
		const first = selectionChips(surface, LIST);
		expect(selectionChips(surface, LIST)).toBe(first);
		expect(first).toMatchObject({ attach: true, detach: true });
		sel.revision = 2;
		sel.strokeIds = ["a", "c"];
		expect(selectionChips(surface, LIST)).toMatchObject({ attach: false, detach: true });
		expect(sets).toBe(3);
		expect(selectionChips({ ...surface, selection: { strokeIds: [], revision: 3, isEmpty: true } }, LIST)).toMatchObject({ attach: false, detach: false });
	});
});

describe("group boxes: each group's union where this surface shows it", () => {
	const strokes = new Map([["a", stroke("a", 10, 10)], ["b", stroke("b", 50, 40)], ["c", stroke("c", 200, 300)]]);
	const members = new Map<string, readonly InkStroke[]>([["g1", [strokes.get("a")!, strokes.get("b")!]], ["g2", [strokes.get("c")!]]]);
	const byId = (id: string) => strokes.get(id);

	it("the union of the members' boxes, moved by the group's correction", () => {
		const boxes = groupBoxes(LIST, members, (id) => (id === "g1" ? { dx: 5, dy: 30 } : { dx: 0, dy: 0 }), () => true, byId);
		expect(boxes).toEqual([
			{ id: "g1", box: { x: 15, y: 40, width: 60, height: 40 }, needs: false },
			{ id: "g2", box: { x: 200, y: 300, width: 20, height: 10 }, needs: false },
		]);
	});

	it("a pending group (no correction yet) is not drawn; a held one is tagged", () => {
		const boxes = groupBoxes(LIST, members, (id) => (id === "g1" ? null : { dx: 0, dy: 0 }), (id) => id !== "g2", byId);
		expect(boxes).toEqual([{ id: "g2", box: { x: 200, y: 300, width: 20, height: 10 }, needs: true }]);
	});

	it("an opaque record is tagged at its raw members' union, and marked opaque so it shows no pin", () => {
		const opaque: AttachmentData = { opaque: true, id: "g9", raw: { v: 2, id: "g9", strokeIds: ["c", 7, "gone"] } };
		expect(groupBoxes([opaque], new Map(), () => null, () => true, byId)).toEqual([{ id: "g9", box: { x: 200, y: 300, width: 20, height: 10 }, needs: true, opaque: true }]);
	});

	it("no groups: nothing, and the members map is not read", () => {
		const trap = new Map() as Map<string, readonly InkStroke[]>;
		trap[Symbol.iterator] = () => { throw new Error("read the members with no groups"); };
		expect(groupBoxes([], trap, () => null, () => true, byId)).toEqual([]);
	});
});

describe("chrome: outline, label and tag", () => {
	const g1: GroupBox = { id: "g1", box: { x: 0, y: 0, width: 50, height: 20 }, needs: false };
	const g2: GroupBox = { id: "g2", box: { x: 100, y: 100, width: 40, height: 40 }, needs: false };
	const held: GroupBox = { id: "g3", box: { x: 300, y: 0, width: 10, height: 10 }, needs: true };

	it("nothing selected and nothing held: no chrome", () => {
		expect(attachChrome([g1, g2], [])).toBe(NO_CHROME);
	});

	it("one group selected: its outline is its union, labelled at its top-left", () => {
		expect(attachChrome([g1, g2], ["g1"])).toEqual({ outlines: [g1.box], labels: [{ box: g1.box, text: ATTACH_STRINGS.attached, needs: false }] });
	});

	it("one group selected reads Attached, a paragraph group as a word group", () => {
		const strokes = new Map([["a", stroke("a", 10, 10)], ["w", stroke("w", 10, 80)]]);
		const word: AttachmentRecord = { ...group("gw", ["w"]), target: targetAt(DOC, 6, 10, "range") };
		const list: AttachmentData[] = [group("gp", ["a"]), word];
		const members = new Map<string, readonly InkStroke[]>([["gp", [strokes.get("a")!]], ["gw", [strokes.get("w")!]]]);
		const boxes = groupBoxes(list, members, () => ({ dx: 0, dy: 0 }), () => true, (id) => strokes.get(id));
		expect(list.map((a) => (a as AttachmentRecord).target.kind), "premise: one paragraph group, one word group").toEqual(["paragraph", "range"]);
		const labelOf = (id: string) => attachChrome(boxes, [id]).labels.map((l) => l.text);
		expect([labelOf("gp"), labelOf("gw")]).toEqual([["Attached"], ["Attached"]]);
	});

	it("two groups selected: both outlined, no label", () => {
		expect(attachChrome([g1, g2], ["g1", "g2"])).toEqual({ outlines: [g1.box, g2.box], labels: [] });
	});

	it("three groups selected: all three outlined, no label", () => {
		const g4: GroupBox = { id: "g4", box: { x: 200, y: 50, width: 30, height: 30 }, needs: false };
		expect(attachChrome([g1, g2, g4], ["g1", "g2", "g4"])).toEqual({ outlines: [g1.box, g2.box, g4.box], labels: [] });
	});

	it("two groups selected, the first one held: both outlined, one tag, on the held box", () => {
		expect(attachChrome([held, g1], ["g3", "g1"])).toEqual({ outlines: [held.box, g1.box], labels: [{ box: held.box, text: ATTACH_STRINGS.needs, needs: true }] });
	});

	it("two groups selected, the second one held: both outlined, one tag, on the held box", () => {
		expect(attachChrome([g1, held], ["g1", "g3"])).toEqual({ outlines: [g1.box, held.box], labels: [{ box: held.box, text: ATTACH_STRINGS.needs, needs: true }] });
	});

	it("a group needing reattachment is tagged whether selected or not, never labelled attached", () => {
		expect(attachChrome([g1, held], [])).toEqual({ outlines: [], labels: [{ box: held.box, text: ATTACH_STRINGS.needs, needs: true }] });
		expect(attachChrome([g1, held], ["g3"])).toEqual({ outlines: [held.box], labels: [{ box: held.box, text: ATTACH_STRINGS.needs, needs: true }] });
	});

	it("a resolved group is never tagged", () => {
		for (const sel of [[], ["g1"], ["g1", "g2"]]) expect(attachChrome([g1, g2], sel).labels.filter((l) => l.needs)).toEqual([]);
	});

	it("draws outlines in the selection colour and labels in the theme's, from the camera alone", () => {
		const calls: string[] = [];
		const tail: ChromeTail = {
			drawSelectionBox: (cam, box, color) => void calls.push(`box ${box.x},${box.y} ${color} @${cam.x},${cam.y},${cam.zoom}`),
			drawGroupTag: (cam, box, label, color, bg, s) => void calls.push(`tag ${label} ${color} ${bg} ${s}`),
			drawAttachPin: (cam, at, color, bg, s) => void calls.push(`pin ${at.x},${at.y} ${color} ${bg} ${s}`),
		};
		drawAttachChrome(tail, { x: 5, y: 6, zoom: 2 }, attachChrome([g1, held], ["g1"]), "#7f9cf5", { text: "T", needs: "N", background: "B", muted: "M" }, 1.5);
		expect(calls).toEqual(["box 0,0 #7f9cf5 @5,6,2", `tag ${ATTACH_STRINGS.attached} T B 1.5`, `tag ${ATTACH_STRINGS.needs} N B 1.5`]);
		calls.length = 0;
		drawAttachChrome(tail, { x: 5, y: 6, zoom: 2 }, { ...attachChrome([g1], ["g1"]), pins: [{ id: "g1", at: { x: 3, y: 4 }, held: false }] }, "#7f9cf5", { text: "T", needs: "N", background: "B", muted: "M" }, 1.5);
		expect(calls.filter((c) => c.startsWith("pin ")), "the selected group's pin in the selection colour").toEqual(["pin 3,4 #7f9cf5 B 1.5"]);
	});
});

describe("a tap inside one group's union narrows two groups to it", () => {
	const outer: GroupBox = { id: "outer", box: { x: 0, y: 0, width: 100, height: 100 }, needs: false };
	const inner: GroupBox = { id: "inner", box: { x: 40, y: 40, width: 10, height: 10 }, needs: false };
	const far: GroupBox = { id: "far", box: { x: 500, y: 500, width: 10, height: 10 }, needs: false };

	it("the group under the tap, the smaller where two overlap, within the pad, none outside", () => {
		const ids = ["outer", "inner", "far"], boxes = [outer, inner, far];
		expect(groupAt(boxes, ids, 10, 10, 0)).toBe("outer");
		expect(groupAt(boxes, ids, 45, 45, 0)).toBe("inner");
		expect(groupAt(boxes, ids, 503, 498, 3)).toBe("far");
		expect(groupAt(boxes, ids, 503, 498, 0)).toBeNull();
		expect(groupAt(boxes, ids, 300, 300, 6)).toBeNull();
	});

	it("only the selected groups are candidates", () => {
		expect(groupAt([outer, inner], ["outer"], 45, 45, 0)).toBe("outer");
	});
});

describe("the mark on the selected group's text", () => {
	const at = (state: EditorState) => {
		const out: Array<[number, number]> = [];
		state.field(attachTargetField).between(0, state.doc.length, (from, to) => void out.push([from, to]));
		return out;
	};

	it("none by default, set by the effect, cleared by null, mapped through an edit before it", () => {
		let s = EditorState.create({ doc: DOC, extensions: attachTargetField });
		expect(at(s)).toEqual([]);
		s = s.update({ effects: setAttachTarget.of({ from: 17, to: 34 }) }).state;
		expect(at(s)).toEqual([[17, 34]]);
		s = s.update({ changes: { from: 0, insert: "new " } }).state;
		expect(at(s)).toEqual([[21, 38]]);
		s = s.update({ effects: setAttachTarget.of(null) }).state;
		expect(at(s)).toEqual([]);
	});

	it("an empty or out-of-range target marks nothing", () => {
		const s = EditorState.create({ doc: DOC, extensions: attachTargetField });
		expect(at(s.update({ effects: setAttachTarget.of({ from: 5, to: 5 }) }).state)).toEqual([]);
		expect(at(s.update({ effects: setAttachTarget.of({ from: 5, to: 999 }) }).state)).toEqual([]);
	});
});

describe("words and colours", () => {
	it("every word attached ink shows comes from the one table: no other string literal in the module", () => {
		const body = decorationSrc.replace(/\r\n/g, "\n");
		const start = body.indexOf("export const ATTACH_STRINGS"), end = body.indexOf("} as const;", start);
		const rest = (body.slice(0, start) + body.slice(end)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		const literals = [...rest.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!).filter((s) => /\s/.test(s) && /[a-z]/i.test(s));
		expect(literals).toEqual([]);
	});

	it("the two-group label has left the table", () => {
		expect(Object.keys(ATTACH_STRINGS)).not.toContain("choose");
	});

	it("the old labels are gone: no file under src or test names them", () => {
		const root = fileURLToPath(new URL("../..", import.meta.url));
		// Built from parts, so this file does not name them itself.
		const old = [["Attached to", "text"].join(" "), ["Attached to the", "first line"].join(" "), ["attached", "FirstLine"].join(""), ["Choose a", "group"].join(" ")];
		const hits: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const at = join(dir, e.name);
				if (e.isDirectory()) walk(at);
				else {
					const text = readFileSync(at, "utf8");
					for (const w of old) if (text.includes(w)) hits.push(`${at.slice(root.length)}: ${w}`);
				}
			}
		};
		walk(join(root, "src"));
		walk(join(root, "test"));
		expect(hits).toEqual([]);
	});

	it("the target mark's style uses theme variables only, no literal colour", () => {
		const block = css.replace(/\r\n/g, "\n").match(/\.hw-attach-target\s*\{[^}]*\}/g);
		expect(block, "no .hw-attach-target rule").not.toBeNull();
		for (const b of block!) {
			expect(b).toMatch(/var\(--/);
			expect(b).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
		}
	});
});

describe("the Attach button's one tap", () => {
	const map = attachmentMembership(LIST);
	let rev = 100;
	const surface = (ids: string[], attachWorks = true) => {
		const calls: string[] = [];
		const o = {
			filePath: () => "toggle.md",
			lineAnchors: { follow: { setList: () => {}, memberMap: map } },
			selection: { strokeIds: ids, revision: rev++, isEmpty: ids.length === 0 },
			attachSelected: () => (calls.push("attach"), attachWorks),
			detachSelected: () => (calls.push("detach"), true),
		};
		return { o, calls };
	};

	it("detaches one whole group or two groups or more, attaches anything else that can attach", () => {
		// Defect: free ink detaches, a whole group attaches again, or two groups do nothing.
		const cases: Array<[string, string[], string[], string | null]> = [
			["free ink", ["free"], ["attach"], "attached"],
			["one whole group", ["a", "b"], ["detach"], "detached"],
			["a group and free ink", ["a", "b", "free"], ["attach"], "attached"],
			["part of a group, no free ink: every selected stroke in the one group", ["a"], ["detach"], "detached"],
			["two groups", ["a", "c"], ["detach"], "detached"],
			["two groups and free ink", ["a", "c", "free"], ["detach"], "detached"],
			["nothing", [], [], null],
		];
		for (const [name, ids, want, did] of cases) {
			const r = surface(ids);
			expect(toggleAttach(r.o, LIST), name).toBe(did);
			expect(r.calls, name).toEqual(want);
		}
	});

	it("Attach with no text under the ink says so and attaches nothing", () => {
		// Defect: the tap fails in silence.
		notices.length = 0;
		const none = surface(["free"], false);
		expect(toggleAttach(none.o, LIST)).toBeNull();
		expect(none.calls).toEqual(["attach"]);
		expect(notices).toEqual([ATTACH_STRINGS.noText]);
	});
});
