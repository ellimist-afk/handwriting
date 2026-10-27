/**
 * The command-palette renames from Alan's "toggles say toggle" ruling -
 * "every toggle should say toggle on/off becuase a toggle is not clear at
 * first" and "why is it named copy selected ink, does it not work on text?"
 * (it is ink only; text is Obsidian's own copy/paste, hence "Lasso: ...") -
 * plus the three commands that ruling moved out of the palette entirely
 * ("pen/highlighter: switch... pen pressure: recalibrate... pressure
 * sensitivity... those are all settings").
 *
 * Pinned as SOURCE TEXT rather than behaviour, deliberately: a command's
 * `name:` is never read by its own callback, so nothing behavioural fails
 * if a rename drifts back, or a removed command's block returns through a
 * bad merge - and this branch is exactly the shape that could happen in,
 * since a sibling slice touches these same callback BODIES while this one
 * renames the `name:` fields beside them. `id:` is the hotkey and doc
 * contract and stays unchanged everywhere a command survives; each pairing
 * below asserts the id alongside its new name so a future change to either
 * has to happen here too.
 *
 * Source text via `import.meta.glob` + `?raw`, the house pattern
 * (StripPenChrome.test.ts, InkSurfaceRules.test.ts): this repo has no
 * `@types/node`, so `fs.readFileSync` fails `tsc -noEmit`. Comments are
 * stripped first through the shared `codeOnly`, so a stale comment
 * mentioning an old name cannot satisfy an assertion below, and a removed
 * id surviving only in prose cannot fail one either - both directions read
 * CODE only.
 */
import { describe, expect, it } from "vitest";
import { codeOnly } from "./CodeOnly";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

// The command registrations live in commands/RegisterCommands.ts, RegisterExportCommands.ts and RegisterDiagCommands.ts, read here with main.ts.
const MAIN = codeOnly([ALL_TS["/src/main.ts"] ?? "", ALL_TS["/src/commands/RegisterCommands.ts"] ?? "", ALL_TS["/src/commands/RegisterExportCommands.ts"] ?? "", ALL_TS["/src/commands/RegisterDiagCommands.ts"] ?? ""].join("\n"));

/**
 * id -> the new `name:` this ruling gave it. Every id here is UNCHANGED -
 * only the palette label moved - so a hotkey bound to one, or a doc that
 * names it, still resolves against this same list.
 */
const RENAMED: [id: string, name: string][] = [
	["inline-tool-eraser", "Toggle eraser on / off"],
	["inline-tool-lasso", "Toggle lasso on / off"],
	["inline-tool-space", "Toggle insert space on / off"],
	["inline-tool-pan", "Toggle pan on / off"],
	["mouse-ink-toggle", "Mouse on / off"],
	// 1.4.12, the second ruling on these two names (alan, 2026-09-05): "there
	// are two of these Handwriting: Pen and Handwriting: toggle pen input
	// on/off - i think that's stupid there should only be one" -> "Pen on /
	// off like Mouse on / off". The id is the old nib command's, so a hotkey
	// bound to `Pen` still resolves; `pen-ink-toggle` is in the removed list
	// below, not here.
	["inline-tool-pen", "Pen on / off"],
	["delete-selected-ink", "Lasso: delete selection"],
	["copy-selected-ink", "Lasso: copy selection"],
	["cut-selected-ink", "Lasso: cut selection"],
	["paste-ink", "Lasso: paste"],
	["open-pen-diagnostics", "Diagnostics: open pen probe"],
];

describe("command palette: surviving ids carry the renamed labels", () => {
	it.each(RENAMED)("%s -> %j", (id, name) => {
		expect(MAIN).toMatch(idThenName(id, name));
	});
});

it("the commands taken out of the palette no longer have an addCommand block", () => {
	// Pen/highlighter switch, pressure recalibrate, pressure-sensitivity
	// toggle - recalibrate now runs from the Settings tab's Developer group
	// (renderPressureRecalibrate) and pressure is always on since 1.4.20, Pen
	// and Highlighter already exist as their own commands.
	//
	// `pen-ink-toggle` joined them in 1.4.12, for a different reason: not a
	// setting, but a second name for something `Pen on / off` now says by
	// itself. Its MECHANISM is untouched - see PenCommandIsOne.test.ts, which
	// pins both that the palette lost it and that the strip's keyboard button
	// still reaches the switch by that id.
	for (const id of [
		"inline-tool-toggle",
		"pressure-recalibrate",
		"ink-shaping-toggle",
		"pen-ink-toggle",
	]) {
		expect(MAIN).not.toContain(`id: "${id}"`);
	}
});

/**
 * `id: "<id>", name: "<name>"` - the exact pairing every addCommand block in
 * main.ts writes, whitespace-tolerant (`\s` crosses the newline between the
 * two properties) so reformatting the file cannot break this on its own.
 */
function idThenName(id: string, name: string): RegExp {
	const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`id:\\s*"${esc(id)}"\\s*,\\s*name:\\s*"${esc(name)}"`);
}
