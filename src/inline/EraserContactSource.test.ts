/**
 * A guard over the ERASER CONTACT PATH, because the 1.4.12 report was filed
 * against the wrong toast and the cheapest way to keep that from happening
 * twice is to be able to prove where a pen contact can and cannot reach.
 *
 * WHAT WAS REPORTED. Alan, hardware, on `vault test 2`: "holding ctrl and
 * touching eraser end to screen spams toast notification - there is no ink on
 * the note to erase, even though there is". That was read as the
 * `delete-all-ink` command's "Handwriting: no ink on this note", which would
 * have meant a pen contact was somehow running a palette command - a keyboard
 * event synthesised by the eraser, a hotkey collision, or a plugin path
 * dispatching a command id off `buttons & 32`.
 *
 * WHAT IS ACTUALLY THE CASE, and what this file pins:
 *
 *   - the toast is `InkOverlay.penDown`'s own "no ink on the page to erase",
 *     three words from Alan's wording and on the eraser branch itself;
 *   - the eraser branch reaches no palette command at all. Not once per
 *     contact, not once per sample, not ever;
 *   - `handwriting:delete-all-ink` is dispatched from nowhere in the tree. It
 *     exists as an `addCommand` id and as nothing else, so no pen path, strip
 *     button or keyboard handler can invoke it however it is provoked.
 *
 * THE ERASER CELLS RUN THE CONTACT. They used to read the eraser branch of
 * `penDown` out of `InkOverlay.ts` as text. Now a real overlay, mounted all
 * the way (`mountRig.test.util.ts`), takes the reported contact itself: the
 * eraser end, Ctrl held, again and again, on a note with no ink and on one
 * with ink. Obsidian's `app` - the overlay's only route to the command
 * palette, read from the editor's info field, and the global one beside it -
 * is a spy, and so is the Notice. A scrub that reached a command, spoke more
 * than once, or erased differently under a modifier fails on the run, in
 * whatever file the branch lives.
 *
 * What a run cannot see, said plainly: a call that sits on the branch and is
 * not reached by these contacts. The contacts here are the reported one and
 * its neighbours (each modifier, each end of the pen, empty and inked notes),
 * which is every input the branch reads.
 *
 * `handwriting:delete-all-ink` stays a whole-tree read: its claim is that no
 * file in the tree dispatches the id, a property of the tree, and that read
 * keys on no one file. Source text via `import.meta.glob` + `?raw`, and
 * comments blanked with `codeOnly`, for the reasons those two carry in
 * `InkSurfaceRules.test.ts` and `CodeOnly.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.messages.push(message);
			}
		},
	};
});

import { codeOnly } from "../CodeOnly";
import type { InkStroke } from "../ink/Stroke";
import { inlineInk } from "./InkOverlay";
import { mountOverlay } from "./mountRig.test.util";
import { resetTipModeForTest } from "./TipMode";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/** A file's code, comments blanked. Throws on a rename rather than passing vacuously. */
function code(file: string): string {
	const text = ALL_TS[file];
	if (text === undefined) throw new Error(`not in the source scan: ${file}`);
	return codeOnly(text);
}

const EMPTY_ERASE = "Handwriting: no ink on the page to erase";

type Modifiers = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
const MODIFIER_SETS: ReadonlyArray<readonly [string, Modifiers]> = [
	["no modifier", {}],
	["ctrl", { ctrlKey: true }],
	["meta", { metaKey: true }],
	["alt", { altKey: true }],
	["shift", { shiftKey: true }],
	["every modifier", { ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }],
];

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
		createdAt: 0,
	} as InkStroke;
}

/**
 * A mounted overlay whose `app` is a spy, driven through its real `penDown`
 * and `penUp`. The eraser end is `buttons & 32` with button 5, the way a
 * digitizer reports it; the nib is button 0.
 */
function contactRig(path: string) {
	const executeCommandById = vi.fn();
	const app = { commands: { executeCommandById } };
	const g = globalThis as { app?: unknown };
	const hadApp = "app" in g;
	const oldApp = g.app;
	g.app = app;
	let m: ReturnType<typeof mountOverlay>;
	try {
		m = mountOverlay(path, { app });
	} catch (e) {
		if (hadApp) g.app = oldApp;
		else delete g.app;
		throw e;
	}
	const o = m.o as Record<string, unknown> & {
		penDown(sample: unknown, ev: unknown): void;
		penUp(ev?: unknown): void;
		mode: string;
	};
	const sample = { x: 60, y: 60, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
	return {
		executeCommandById,
		/** One contact; returns the gesture mode penDown chose. */
		contact(end: "eraser" | "nib", mods: Modifiers = {}): string {
			const ev = {
				pointerType: "pen",
				buttons: end === "eraser" ? 32 : 1,
				button: end === "eraser" ? 5 : 0,
				clientX: sample.x,
				clientY: sample.y,
				ctrlKey: false,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				...mods,
			};
			o.penDown(sample, ev);
			const mode = o.mode;
			o.penUp({ ...ev, buttons: 0 });
			return mode;
		},
		done() {
			try {
				m.destroy();
			} finally {
				if (hadApp) g.app = oldApp;
				else delete g.app;
			}
		},
	};
}

describe("the eraser contact path", () => {
	beforeEach(() => {
		resetTipModeForTest();
		notices.messages = [];
	});
	afterEach(() => resetTipModeForTest());

	it("reaches no palette command, however many contacts a scrub makes", () => {
		// The reported contact, five times over: the eraser end with Ctrl held,
		// on a note with no ink and on one with ink. Every route the overlay
		// has to a command goes through `app.commands`, and that is the spy.
		for (const [path, ink] of [["eraser-scrub-empty.md", false], ["eraser-scrub-inked.md", true]] as const) {
			if (ink) inlineInk.commitGesture(path, [stroke(`${path}-1`)]);
			const rig = contactRig(path);
			try {
				for (let i = 0; i < 5; i++) {
					expect(rig.contact("eraser", { ctrlKey: true }), "precondition: the eraser end erased").toBe("erase");
				}
				expect(rig.executeCommandById, `an eraser scrub on ${path} ran a palette command`).not.toHaveBeenCalled();
			} finally {
				rig.done();
			}
		}
	});

	it("says its one thing through the gate, so a scrub cannot repeat it", () => {
		// One sentence for the whole scrub, and it is the page's own refusal,
		// not the delete-all command's. A bare `new Notice` on the branch is
		// what fired per contact; the gate answers once per note.
		const rig = contactRig("eraser-says-once.md");
		try {
			for (let i = 0; i < 5; i++) rig.contact("eraser", { ctrlKey: true });
		} finally {
			rig.done();
		}
		expect(notices.messages, "a five-contact scrub on an empty note did not say its sentence exactly once").toEqual([EMPTY_ERASE]);
	});

	it("still decides erase-vs-ink from the pen alone, never from a modifier", () => {
		// The report named Ctrl. Nothing on this path reads a modifier, and
		// the arbitration it does use takes buttons and the strip mode only
		// (TipMode.penContactIntent). So every modifier, alone and together,
		// leaves the eraser end erasing and the nib inking.
		const rig = contactRig("eraser-modifiers.md");
		try {
			for (const [name, mods] of MODIFIER_SETS) {
				expect(rig.contact("eraser", mods), `the eraser end with ${name} did not erase`).toBe("erase");
				expect(rig.contact("nib", mods), `the nib with ${name} did not ink`).toBe("ink");
			}
		} finally {
			rig.done();
		}
	});
});

describe("handwriting:delete-all-ink", () => {
	/**
	 * The whole tree, not one file: the point is that NOTHING dispatches it,
	 * so a per-file check would only be as good as the list of files someone
	 * remembered - the exact failure `StripPenChrome.test.ts` inverted its
	 * allowlist to avoid.
	 */
	const files = Object.keys(ALL_TS).filter((f) => !f.endsWith(".test.ts"));

	it("is declared in exactly one place and dispatched from none", () => {
		const declaring: string[] = [];
		const dispatching: string[] = [];
		for (const file of files) {
			const text = code(file);
			// CommandPaletteSplit.ts writes the same `id: "..."` shape for
			// every palette entry, but it REGISTERS nothing: it is the table
			// the settings row prints and the split test reads. The claim
			// here is about registration, so the table is not a declaration.
			if (file !== "/src/CommandPaletteSplit.ts" && text.includes('id: "delete-all-ink"'))
				declaring.push(file);
			// A dispatch needs the id in its command-palette form. The
			// `addCommand` declaration above is the bare id; anything that
			// RUNS it has to name the plugin prefix too.
			if (text.includes("handwriting:delete-all-ink")) dispatching.push(file);
		}
		expect(declaring).toEqual(["/src/commands/RegisterExportCommands.ts"]);
		expect(dispatching).toEqual([]);
	});

	it("is not on any pen-tools strip button", () => {
		// The strip is the one thing in the plugin that turns a pen tap into
		// a command id, so it is the one place a pen COULD reach a palette
		// command. The strip is split over several files, and a button can be
		// declared in any of them, so every non-test file of the strip and of the
		// note zoom controls is read, not one named file. The list must hold the
		// button table, or the loop below could pass over nothing.
		const stripFiles = files.filter((f) => /^\/src\/inline\/(MobileTools|NoteZoomControls)/.test(f));
		expect(stripFiles, "the strip's button table is not among the files read").toContain("/src/inline/MobileToolsButtons.ts");
		for (const file of stripFiles) {
			expect(code(file), `${file} names the delete-all command`).not.toContain("delete-all-ink");
		}
	});

	it("declares no default hotkey anywhere, so nothing binds it by accident", () => {
		// `addCommand({ hotkeys: [...] })` is how a plugin claims a chord.
		// This plugin claims none - every binding in a vault is the user's
		// own, which is what made the vault's hotkeys.json the place to look
		// when the report named Ctrl.
		for (const file of files) {
			expect(code(file), `${file} declares a default hotkey`).not.toContain("hotkeys:");
		}
	});
});
