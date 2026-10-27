/**
 * The 1.4.12 palette split, pinned where it can actually break.
 *
 * Three claims, and none of them is behaviour this repo can execute: every
 * command is an `addCommand` callback needing a real plugin `this`, which is
 * why CommandPaletteNames.test.ts beside this one reads source too. What is
 * worth pinning is structural anyway -
 *
 *   1. every gated id registers under the gated path, with the name the table
 *      says it has, so the list Settings prints is the list the palette gets;
 *   2. the canvas entry commands register while parked `Canvas tool:`
 *      commands cannot come back through a merge unnoticed;
 *   3. the settings row prints the table rather than a second copy of it - the
 *      one thing that makes claim 1 worth anything;
 *   4. the two ROUTES a gated command can answer through - registered in the
 *      palette, or mirrored for the pen toolbar - stay exclusive across every
 *      flip of the switch, which is what `planGatedCommands` is for and what
 *      the machinery under it (`setGatedCommandAction`, `runGatedCommand`,
 *      `clearGatedCommandAction(s)`) had no test of its own for at all;
 *   5. the settings handler actually runs that plan, so the switch is live
 *      rather than a value the next reload happens to read.
 *
 * Source text via `?raw`, comments blanked with `codeOnly`, both for the
 * reasons that technique carries everywhere in this repo. The settings slice
 * normalises CRLF and asserts BOTH anchors were found: a slice that silently
 * became the whole file would pass every `toContain` below for free.
 */
import { beforeEach, describe, expect, it } from "vitest";
import mainSrc from "./main.ts?raw";
import commandsSrc from "./commands/RegisterCommands.ts?raw";
import exportCommandsSrc from "./commands/RegisterExportCommands.ts?raw";
import applySrc from "./PluginApply.ts?raw";
import tabSrc from "./settings/HandwritingSettingTab.ts?raw";
import { gatedCommandGroups } from "./main";
import { codeOnly } from "./CodeOnly";
import {
	ALWAYS_COMMANDS,
	GATED_FIXED_COMMANDS,
	GatedCommandPlan,
	clearGatedCommandAction,
	clearGatedCommandActions,
	gatedCommandActionIds,
	gatedCommandNames,
	gatedCommands,
	gatedGeneratedCommands,
	gatedPresetCommands,
	inkColorNames,
	planGatedCommands,
	runGatedCommand,
	setGatedCommandAction,
} from "./CommandPaletteSplit";
import { HIGHLIGHTER_COLORS, PEN_COLORS } from "./ink/InkColor";
import { INK_SIZE_STEPS } from "./ink/InkSize";
import { PRESET_COMMANDS } from "./ink/InkPresetCommands";

/** main.ts's code, without main.ts's prose about it. */
// The command registrations live in commands/RegisterCommands.ts and RegisterExportCommands.ts, read here with main.ts.
// The setting appliers live in PluginApply.ts, read here with main.ts too.
const MAIN = codeOnly([mainSrc, commandsSrc, exportCommandsSrc, applySrc].join("\n").replace(/\r\n/g, "\n"));
/** The settings page's code, the same way. */
const TAB = codeOnly(tabSrc.replace(/\r\n/g, "\n"));

/** Every `addGatedCommand({ ... })` body in main.ts, brace-matched. */
function gatedBlocks(): string[] {
	const out: string[] = [];
	const marker = "addGatedCommand({";
	for (let at = MAIN.indexOf(marker); at > -1; at = MAIN.indexOf(marker, at + 1)) {
		let depth = 0;
		let i = at + marker.length - 1;
		for (; i < MAIN.length; i++) {
			if (MAIN[i] === "{") depth++;
			else if (MAIN[i] === "}" && --depth === 0) break;
		}
		out.push(MAIN.slice(at, i + 1));
	}
	return out;
}

/** `id: "<id>", name: "<name>"`, whitespace-tolerant across the newline. */
function idThenName(id: string, name: string): RegExp {
	const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`id:\\s*"${esc(id)}"\\s*,\\s*name:\\s*"${esc(name)}"`);
}

describe("the gated set: table and registration agree", () => {
	it.each(GATED_FIXED_COMMANDS.map((c) => [c.id, c.name] as const))(
		"%s registers as %j",
		(id, name) => {
			expect(MAIN).toMatch(idThenName(id, name));
		}
	);

	it.each(GATED_FIXED_COMMANDS.map((c) => [c.id] as const))(
		"%s registers through addGatedCommand, not this.addCommand",
		(id) => {
			// The registration immediately before this id has to be the gated
			// one. Sliced backwards from the id so a reordering of the file
			// cannot make this pass by finding some other command's call.
			const at = MAIN.indexOf(`id: "${id}"`);
			expect(at, id).toBeGreaterThan(-1);
			const before = MAIN.slice(0, at);
			const gated = before.lastIndexOf("addGatedCommand({");
			const plain = before.lastIndexOf("this.addCommand({");
			expect(gated, `${id} is not registered by addGatedCommand`).toBeGreaterThan(plain);
		}
	);

	it("generates per-size and per-colour entries exactly as main.ts does", () => {
		// The table computes these; this is the assertion that its arithmetic
		// matches the loops. Both walk the same three constants.
		expect(gatedGeneratedCommands()).toEqual([
			...INK_SIZE_STEPS.map((s) => ({ id: `ink-size-${s.name}`, name: `Ink size: ${s.name}` })),
			...inkColorNames().map((n) => ({ id: `ink-color-${n}`, name: `Ink color: ${n}` })),
			...HIGHLIGHTER_COLORS.map((c) => ({
				id: `highlighter-color-${c.name}`,
				name: `Highlighter color: ${c.name}`,
			})),
		]);
		expect(inkColorNames()).toEqual([
			...new Set([...PEN_COLORS, ...HIGHLIGHTER_COLORS].map((c) => c.name)),
		]);
	});

	it("registers the generated ones from the same three constants", () => {
		for (const needle of [
			"id: `ink-size-${step.name}`",
			"name: `Ink size: ${step.name}`",
			"id: `ink-color-${name}`",
			"name: `Ink color: ${name}`",
			"id: `highlighter-color-${c.name}`",
			"name: `Highlighter color: ${c.name}`",
		]) {
			expect(MAIN, needle).toContain(needle);
		}
		// The union the ink-colour loop walks comes from the table, not a
		// second `new Set([...PEN_COLORS, ...HIGHLIGHTER_COLORS])` in main.ts.
		expect(MAIN).toContain("const names = inkColorNames();");
	});

	it("retires the toolbar command with its settings row", () => {
		expect(GATED_FIXED_COMMANDS.map((c) => c.id)).not.toContain("pen-tools-cycle");
		expect(ALWAYS_COMMANDS.map((c) => c.id)).not.toContain("pen-tools-cycle");
		expect(MAIN).not.toContain('id: "pen-tools-cycle"');
		// Fourteen after `pen-ink-toggle` and `pen-tools-cycle` both left the
		// palette; fifteen with the toolbar and zoom bar on / off toggle (1.4.20),
		// a new id, not the retired cycle. The exact count stops either retired
		// command creeping back in.
		expect(ALWAYS_COMMANDS).toHaveLength(15);
	});
});

/**
 * QUICK PENS' sixteen, spliced into the gated set (1.4.12).
 *
 * Claim 1 above - "every gated id registers under the gated path, with the
 * name the table says it has" - has to hold for these too, and the source
 * probe the fixed entries use cannot reach them: main.ts spells no preset id.
 * It hands `addGatedCommand` to `registerInkPresetCommands` and the preset
 * table names all sixteen. So the claim splits in two, and both halves are
 * pinned - here that the split's list IS that table, and in
 * InkPresetCommands.test.ts that the registrar main.ts calls is the gated
 * adder rather than the plugin's own `addCommand`.
 */
describe("the gated set includes quick pens' preset commands", () => {
	it("borrows the preset table rather than restating it", () => {
		expect(gatedPresetCommands()).toEqual(
			PRESET_COMMANDS.map((c) => ({ id: c.id, name: c.name }))
		);
		expect(gatedPresetCommands()).toHaveLength(16);
	});

	it("puts every one of them in gatedCommands(), last", () => {
		const all = gatedCommands();
		const tail = all.slice(all.length - PRESET_COMMANDS.length);
		expect(tail.map((c) => c.id)).toEqual(PRESET_COMMANDS.map((c) => c.id));
	});

	it("so the settings list prints all sixteen names", () => {
		const names = gatedCommandNames();
		for (const c of PRESET_COMMANDS) expect(names, c.id).toContain(c.name);
	});

	it("registers them through the gated adder, from the table", () => {
		// The other half of claim 1. Both ends of the slice asserted: the call
		// exists, and the helper it is handed is the one the switch reads.
		const call = MAIN.indexOf("registerInkPresetCommands({ addCommand: addGatedCommand })");
		expect(call, "main.ts does not register the preset table through addGatedCommand").toBeGreaterThan(-1);
		const gate = MAIN.indexOf("const addGatedCommand = (cmd: Command): void => {");
		expect(gate, "main.ts no longer defines addGatedCommand").toBeGreaterThan(-1);
		expect(call, "the call must sit after the helper it names").toBeGreaterThan(gate);
		// And never the ungated form, which would register all sixteen with
		// the switch off - the drift the settings row cannot survive.
		expect(MAIN).not.toContain("registerInkPresetCommands(this)");
	});
});

describe("the always set stays registered outright", () => {
	it.each(ALWAYS_COMMANDS.map((c) => [c.id, c.name] as const))("%s -> %j", (id, name) => {
		expect(MAIN).toMatch(idThenName(id, name));
		const at = MAIN.indexOf(`id: "${id}"`);
		const before = MAIN.slice(0, at);
		expect(
			before.lastIndexOf("this.addCommand({"),
			`${id} must not be behind the setting`
		).toBeGreaterThan(before.lastIndexOf("addGatedCommand({"));
	});
});

describe("the settings row prints the shared table", () => {
	// Both anchors asserted, and the window asserted non-trivial: the three
	// ways a bounded-slice guard goes vacuous are a missing opener, a missing
	// closer, and a window that closes before it opens.
	const OPEN = 'name: "Extra commands for hotkeys"';
	const CLOSE = 'heading: "Developer"';

	function row(): string {
		const from = TAB.indexOf(OPEN);
		const to = TAB.indexOf(CLOSE);
		expect(from, `anchor ${OPEN} in the settings tab`).toBeGreaterThan(-1);
		expect(to, `anchor ${CLOSE} in the settings tab`).toBeGreaterThan(-1);
		expect(to).toBeGreaterThan(from);
		const slice = TAB.slice(from, to);
		expect(slice.length).toBeLessThan(4000);
		return slice;
	}

	it("keeps the old label searchable", () => {
		expect(row()).toContain('"Hotkeys for colors and sizes"');
	});

	/**
	 * The method that draws the lines, sliced between its own signature and the
	 * next method's. Both ends asserted and the window bounded, for the reasons
	 * `row()` above states.
	 */
	function renderer(): string {
		const from = TAB.indexOf("private renderGatedCommands(setting: Setting): void {");
		expect(from, "the settings tab no longer defines renderGatedCommands").toBeGreaterThan(-1);
		const to = TAB.indexOf("private renderSupport(", from);
		expect(to, "anchor private renderSupport( after renderGatedCommands").toBeGreaterThan(from);
		const slice = TAB.slice(from, to);
		expect(slice.length).toBeLessThan(2000);
		return slice;
	}

	it("renders the list from the shared table, not a copy", () => {
		// The row delegates to a renderer now, because the list is a few
		// labelled lines rather than one string ("this is hilariously dense",
		// alan, 2026-09-06). The table is still what it reads: the grouping
		// function takes `gatedCommands()` by default and regroups it.
		const slice = row();
		expect(slice).toContain("this.renderGatedCommands(setting)");
		const draw = renderer();
		expect(draw).toContain("gatedCommandGroups()");
		// A hand-written list beside the switch is exactly the drift this
		// file exists to prevent, so no gated name may appear as a literal -
		// in the row or in the renderer it now hands off to.
		for (const name of gatedCommandNames()) {
			expect(slice, `${name} is spelled out beside the switch`).not.toContain(`"${name}"`);
			expect(draw, `${name} is spelled out in the renderer`).not.toContain(`"${name}"`);
		}
	});

	it("still gates on the 1.4.6 key, so data.json survives the rename", () => {
		expect(row()).toContain('key: "colorSizeCommands"');
	});

	it("stops promising a reload for a switch that is live", () => {
		const slice = row();
		// The sentence the row carried from 1.4.6 to 1.4.11, gone as an
		// unconditional claim - and gone from the CODE, since `row()` reads
		// main.ts through `codeOnly` and a commented-out copy is blanks.
		expect(slice).not.toContain(
			"crowded out the export and flatten commands. Takes effect after the plugin reloads."
		);
		// Kept for the one app where it is still true, and asked at render time
		// rather than decided when this file was written.
		expect(slice).toContain("this.plugin.gatedCommandRemovalAvailable()");
		expect(slice).toContain("Turning it off takes effect after the plugin reloads.");
	});
});

/**
 * THE LINES UNDER THE SWITCH (1.4.12, amended 2026-09-06).
 *
 * "this is hilariously dense" - the row printed forty-three names as one comma
 * run. The ruling keeps the list and breaks it into short labelled lines, one
 * per kind, with the membership DERIVED FROM THE IDS rather than typed out, so
 * the property the whole palette-split file exists for survives: a colour added
 * to `PEN_COLORS` reaches the settings row on its own.
 *
 * The load-bearing assertion is the partition. Every gated id on exactly one
 * line means a command can never be added to the palette and quietly left off
 * the list a user reads to find out what there is to bind - which is the one
 * failure a grouped list can have that a single comma run cannot.
 */
describe("the settings row groups the gated commands", () => {
	it("puts every gated id on exactly one line", () => {
		const seen = gatedCommandGroups().flatMap((g) => g.ids);
		expect(new Set(seen).size, "an id is on two lines").toBe(seen.length);
		expect([...seen].sort()).toEqual([...gatedCommands().map((c) => c.id)].sort());
	});

	it("counts the same names out as gatedCommandNames() prints", () => {
		const printed = gatedCommandGroups().reduce((n, g) => n + g.names.length, 0);
		expect(printed).toBe(gatedCommandNames().length);
	});

	it("has no leftovers: every id matches a rule", () => {
		// "Other" is the bucket an unrecognised id shape falls into, so the
		// list can never lose one. It being EMPTY is what says the rules still
		// describe the table - and this is the test that goes red when a
		// command arrives with an id nobody wrote a rule for.
		const other = gatedCommandGroups().find((g) => g.label === "Other");
		expect(other?.ids ?? [], `unrecognised ids: ${(other?.ids ?? []).join(", ")}`).toEqual([]);
	});

	it("catches an id no rule claims rather than dropping it", () => {
		const groups = gatedCommandGroups([{ id: "brand-new-thing", name: "Brand new thing" }]);
		expect(groups).toEqual([
			{ label: "Other", ids: ["brand-new-thing"], names: ["Brand new thing"] },
		]);
	});

	it("reads as nine short lines", () => {
		// Every user-facing string on the row, pinned. The three tables the
		// generated groups come from are read rather than typed out, so adding
		// a colour changes this expectation the same way it changes the row.
		const lines = gatedCommandGroups().map((g) => `${g.label}: ${g.names.join(", ")}`);
		expect(lines).toEqual([
			"Tool toggles: eraser, lasso, insert space, pan",
			"Cycles: Ink color, Pen color, Highlighter color, Ink size, Eraser size",
			`Ink size: ${INK_SIZE_STEPS.map((s) => s.name).join(", ")}`,
			`Ink color: ${inkColorNames().join(", ")}`,
			`Highlighter color: ${HIGHLIGHTER_COLORS.map((c) => c.name).join(", ")}`,
			"Pen preset: 1, 2, 3, 4",
			"Save current pen as preset: 1, 2, 3, 4",
			"Highlighter preset: 1, 2, 3, 4",
			"Save current highlighter as preset: 1, 2, 3, 4",
		]);
	});

	it("keeps every line short enough to read on a phone", () => {
		// The complaint in one number. The old row was a single 700-character
		// paragraph; a line that grows back past this is a group that has
		// stopped being a group.
		for (const line of gatedCommandGroups().map((g) => `${g.label}: ${g.names.join(", ")}`)) {
			expect(line.length, line).toBeLessThanOrEqual(90);
		}
	});

	it("shortens a name only by wording its own label carries", () => {
		// The line prints "blue", not "Ink color: blue", and the shortening is
		// mechanical - the head and tail every name in the group shares, cut at
		// a word boundary. Whatever it removes, what is left has to still be
		// part of the command's real name, or the row is describing commands
		// the palette does not have.
		const byId = new Map(gatedCommands().map((c) => [c.id, c.name]));
		for (const group of gatedCommandGroups()) {
			group.ids.forEach((id, i) => {
				const full = byId.get(id) ?? "";
				expect(full, id).not.toBe("");
				expect(full, `${id} prints as ${group.names[i]}`).toContain(group.names[i] ?? "");
			});
		}
	});

	it("leaves a group of one alone", () => {
		// A single name shares all of itself with itself; trimming against that
		// would print an empty string.
		expect(gatedCommandGroups([{ id: "inline-tool-eraser", name: "Toggle eraser on / off" }])).toEqual([
			{ label: "Tool toggles", ids: ["inline-tool-eraser"], names: ["Toggle eraser on / off"] },
		]);
	});

	it("cuts at a word boundary, never inside one", () => {
		// Two names sharing "Ink color: bl" is a real common prefix and a
		// useless one: it would print "ue" and "ack".
		const groups = gatedCommandGroups([
			{ id: "ink-color-blue", name: "Ink color: blue" },
			{ id: "ink-color-black", name: "Ink color: black" },
		]);
		expect(groups[0]?.names).toEqual(["blue", "black"]);
	});

	it("claims the cycles before the per-value ids they look like", () => {
		// `ink-size-cycle` starts the way `ink-size-fine` does. The rules are
		// ordered for it; this is the test that notices if they are reordered.
		const groups = gatedCommandGroups([
			{ id: "ink-size-cycle", name: "Ink size: next" },
			{ id: "ink-size-fine", name: "Ink size: fine" },
		]);
		expect(groups.map((g) => g.label)).toEqual(["Cycles", "Ink size"]);
		expect(groups[0]?.ids).toEqual(["ink-size-cycle"]);
	});
});

describe("the table itself", () => {
	it("has no id in both sets", () => {
		const gated = new Set(gatedCommands().map((c) => c.id));
		for (const c of ALWAYS_COMMANDS) expect(gated.has(c.id), c.id).toBe(false);
	});

	it("names every gated command exactly once", () => {
		const names = gatedCommandNames();
		expect(new Set(names).size).toBe(names.length);
	});
});

/**
 * THE MIRROR ITSELF (1.4.12). Nothing tested `setGatedCommandAction`,
 * `runGatedCommand` or `clearGatedCommandActions` until this block: the half
 * of the split that keeps the pen toolbar's eraser, lasso, insert-space and
 * pan buttons alive while their commands are out of the palette had every
 * caller pinned and the callee pinned nowhere. Behaviour, not source text -
 * this module runs perfectly well without an Obsidian.
 */
describe("the strip's fallback actions", () => {
	beforeEach(() => clearGatedCommandActions());

	it("runs a filed action by its bare id and by its prefixed one", () => {
		let ran = 0;
		setGatedCommandAction("inline-tool-eraser", () => ran++);
		expect(runGatedCommand("inline-tool-eraser")).toBe(true);
		// The strips call `exec` with the id Obsidian knows the command by,
		// which is the prefixed one (MobileTools.ts, main.ts's pdf bridge).
		expect(runGatedCommand("handwriting:inline-tool-eraser")).toBe(true);
		expect(ran).toBe(2);
	});

	it("answers false for an id it was not given, so the caller can fall through", () => {
		setGatedCommandAction("inline-tool-eraser", () => undefined);
		// The whole point of the boolean: an id with no fallback is one the
		// palette holds, and both bridges then call `executeCommandById`.
		expect(runGatedCommand("inline-tool-lasso")).toBe(false);
		expect(runGatedCommand("handwriting:export-ink-svg")).toBe(false);
		expect(runGatedCommand("")).toBe(false);
	});

	it("clears the lot, and reports what it is holding", () => {
		setGatedCommandAction("inline-tool-eraser", () => undefined);
		setGatedCommandAction("inline-tool-pan", () => undefined);
		expect(gatedCommandActionIds().sort()).toEqual(["inline-tool-eraser", "inline-tool-pan"]);
		clearGatedCommandActions();
		expect(gatedCommandActionIds()).toEqual([]);
		expect(runGatedCommand("inline-tool-eraser")).toBe(false);
	});

	it("drops one without touching the rest", () => {
		setGatedCommandAction("inline-tool-eraser", () => undefined);
		setGatedCommandAction("inline-tool-pan", () => undefined);
		clearGatedCommandAction("inline-tool-eraser");
		// The move the live switch makes for every id it hands back to the
		// palette: that one stops answering, its neighbours do not.
		expect(runGatedCommand("inline-tool-eraser")).toBe(false);
		expect(runGatedCommand("inline-tool-pan")).toBe(true);
		expect(gatedCommandActionIds()).toEqual(["inline-tool-pan"]);
	});
});

/**
 * THE LIVE SWITCH (1.4.12): which ids move on each transition.
 *
 * `planGatedCommands` is the whole decision, so these are behavioural tests of
 * it rather than source probes - putting the decision in a pure function is
 * what makes that possible without an Obsidian to run. The state machine below
 * is main.ts's executor in miniature, and the executor is pinned further down
 * to apply the plan in the same order this one does.
 */
describe("planning a flip of Extra commands for hotkeys", () => {
	const ALL = gatedCommands().map((c) => c.id);

	interface Halves {
		registered: Set<string>;
		mirrored: Set<string>;
	}

	/** Where onload leaves the two halves for a given setting. */
	function loaded(want: boolean): Halves {
		return want
			? { registered: new Set(ALL), mirrored: new Set<string>() }
			: { registered: new Set<string>(), mirrored: new Set(ALL) };
	}

	/** main.ts's executor in miniature: adds before drops, both ways round. */
	function apply(state: Halves, plan: GatedCommandPlan): void {
		for (const id of plan.toRegister) state.registered.add(id);
		for (const id of plan.toMirror) state.mirrored.add(id);
		for (const id of plan.toUnmirror) state.mirrored.delete(id);
		for (const id of plan.toRemove) state.registered.delete(id);
	}

	function flip(state: Halves, want: boolean, canRemove = true): GatedCommandPlan {
		const plan = planGatedCommands({
			registered: state.registered,
			mirrored: state.mirrored,
			want,
			canRemove,
			ids: ALL,
		});
		apply(state, plan);
		return plan;
	}

	/** The invariant, asserted rather than described. */
	function exactlyOneRoute(state: Halves): void {
		for (const id of ALL) {
			const routes = (state.registered.has(id) ? 1 : 0) + (state.mirrored.has(id) ? 1 : 0);
			expect(routes, id + " answers through " + routes + " routes, not 1").toBe(1);
		}
	}

	function empty(plan: GatedCommandPlan): void {
		expect({
			toRegister: plan.toRegister,
			toRemove: plan.toRemove,
			toMirror: plan.toMirror,
			toUnmirror: plan.toUnmirror,
		}).toEqual({ toRegister: [], toRemove: [], toMirror: [], toUnmirror: [] });
	}

	it("turning it ON registers every gated id and unfiles every fallback", () => {
		const state = loaded(false);
		const plan = flip(state, true);
		expect(plan.toRegister).toEqual(ALL);
		expect(plan.toUnmirror).toEqual(ALL);
		expect(plan.toRemove).toEqual([]);
		expect(plan.toMirror).toEqual([]);
		expect([...state.registered]).toEqual(ALL);
		expect([...state.mirrored]).toEqual([]);
	});

	it("turning it OFF files every fallback and un-registers every id", () => {
		const state = loaded(true);
		const plan = flip(state, false);
		expect(plan.toMirror).toEqual(ALL);
		expect(plan.toRemove).toEqual(ALL);
		expect(plan.toRegister).toEqual([]);
		expect(plan.toUnmirror).toEqual([]);
		expect([...state.mirrored]).toEqual(ALL);
		expect([...state.registered]).toEqual([]);
	});

	it("plans quick pens' sixteen too, not just the fixed nine", () => {
		// The gated set is the table, and the table ends with the preset
		// commands - the one group main.ts never spells out.
		const plan = flip(loaded(false), true);
		for (const c of gatedPresetCommands()) expect(plan.toRegister, c.id).toContain(c.id);
		for (const c of GATED_FIXED_COMMANDS) expect(plan.toRegister, c.id).toContain(c.id);
		expect(plan.toRegister).toHaveLength(gatedCommands().length);
	});

	it("is idempotent: toggling on twice registers once", () => {
		const state = loaded(false);
		flip(state, true);
		empty(flip(state, true));
		empty(flip(state, true));
		expect([...state.registered]).toEqual(ALL);
	});

	it("is idempotent the other way too", () => {
		const state = loaded(true);
		flip(state, false);
		empty(flip(state, false));
		expect([...state.mirrored]).toEqual(ALL);
	});

	it("asks for nothing when the plugin loaded in the state the switch names", () => {
		empty(flip(loaded(true), true));
		empty(flip(loaded(false), false));
	});

	it("keeps exactly one route per id across a whole on/off cycle", () => {
		const state = loaded(false);
		exactlyOneRoute(state);
		for (const want of [true, false, true, true, false]) {
			flip(state, want);
			exactlyOneRoute(state);
		}
	});

	it("moves only the ids that are on the wrong side", () => {
		// A half-and-half state - the shape a partly applied flip would leave.
		const half = Math.floor(ALL.length / 2);
		const state: Halves = {
			registered: new Set(ALL.slice(0, half)),
			mirrored: new Set(ALL.slice(half)),
		};
		const plan = flip(state, true);
		expect(plan.toRegister).toEqual(ALL.slice(half));
		expect(plan.toUnmirror).toEqual(ALL.slice(half));
		exactlyOneRoute(state);
	});

	it("with no way to un-register, OFF changes nothing rather than double-routing", () => {
		// The honest degradation. Filing fallbacks for commands that are still
		// in the palette is the one move that breaks the split, so it is
		// refused, and the settings row keeps its reload sentence instead.
		const state = loaded(true);
		empty(flip(state, false, false));
		expect([...state.registered]).toEqual(ALL);
		expect([...state.mirrored]).toEqual([]);
		exactlyOneRoute(state);
	});

	it("with no way to un-register, turning it ON is still live", () => {
		const state = loaded(false);
		const plan = flip(state, true, false);
		expect(plan.toRegister).toEqual(ALL);
		expect(plan.toUnmirror).toEqual(ALL);
		exactlyOneRoute(state);
	});

	it("takes an id out of the palette even after it has left the table", () => {
		// A command dropped from the gated set between two releases is still
		// in the registry of a running app. Folding the live sets into the
		// plan is what stops it sitting there with no rule able to remove it.
		const plan = planGatedCommands({
			registered: ["retired-command"],
			mirrored: [],
			want: false,
			canRemove: true,
			ids: [],
		});
		expect(plan.toRemove).toEqual(["retired-command"]);
		expect(plan.toMirror).toEqual(["retired-command"]);
	});

	it("defaults to the shared table when the caller names no ids", () => {
		// The settings row, the registration and the plan are one list, or
		// they are three lists that drift.
		const plan = planGatedCommands({ registered: [], mirrored: [], want: true, canRemove: true });
		expect(plan.toRegister).toEqual(ALL);
	});
});

/**
 * And that main.ts runs that plan, rather than reading the setting once at
 * load. Source text, because the executor needs a live plugin `this` - the
 * same reason everything above the settings row in this file reads source.
 */
describe("the settings handler applies the plan instead of waiting for a reload", () => {
	const OPEN = 'case "colorSizeCommands":';
	const CLOSE = 'case "devDiagnostics":';

	function handler(): string {
		const from = TAB.indexOf(OPEN);
		const to = TAB.indexOf(CLOSE);
		expect(from, "anchor " + OPEN + " in the settings tab").toBeGreaterThan(-1);
		expect(to, "anchor " + CLOSE + " in the settings tab").toBeGreaterThan(-1);
		expect(to).toBeGreaterThan(from);
		const slice = TAB.slice(from, to);
		expect(slice.length).toBeLessThan(1500);
		return slice;
	}

	it("calls the executor when the switch moves", () => {
		expect(handler()).toContain("this.plugin.applyGatedCommandRegistration();");
	});

	it("applies the plan adds-first, so no id is left without a route", () => {
		// Both ends of the slice asserted, and the ORDER asserted rather than
		// the text: a command must be registered before its fallback is
		// dropped, and its fallback filed before it leaves the palette.
		const from = MAIN.indexOf("applyGatedCommandRegistration(this: HandwritingPlugin): void {");
		expect(from, "main.ts no longer defines the executor").toBeGreaterThan(-1);
		const end = MAIN.indexOf("\n\t}", from);
		expect(end, "the executor has no end").toBeGreaterThan(from);
		const body = MAIN.slice(from, end);
		expect(body.length).toBeLessThan(2000);
		for (const half of ["plan.toRegister", "plan.toRemove", "plan.toMirror", "plan.toUnmirror"]) {
			expect(body, half).toContain(half);
		}
		expect(body.indexOf("plan.toRegister")).toBeLessThan(body.indexOf("plan.toUnmirror"));
		expect(body.indexOf("plan.toMirror")).toBeLessThan(body.indexOf("plan.toRemove"));
	});

	it("guards the un-registration route rather than assuming it", () => {
		// `Plugin.removeCommand` is declared in obsidian.d.ts and the app's
		// own command registry is not declared at all; neither is proof of
		// what the app someone is running actually has.
		expect(MAIN).toContain('typeof this.removeCommand === "function"');
		expect(MAIN).toContain("gatedCommandRemovalAvailable()");
		// And the row still carries the reload sentence for that case.
		expect(TAB).toContain("Turning it off takes effect after the plugin reloads.");
	});

	it("gives every gated command a callback, so the mirror can hold all of them", () => {
		// The assumption `registeredGatedCommandIds` rests on: registered and
		// mirrored are complements, which needs every gated command to be
		// mirrorable. A `checkCallback` one would be filed nowhere while the
		// switch is off - a dead strip button, and an id the live switch
		// would never hand back to the palette.
		const blocks = gatedBlocks();
		expect(blocks.length, "no addGatedCommand blocks found in main.ts").toBeGreaterThanOrEqual(12);
		for (const body of blocks) {
			expect(body, "a gated command with no callback: " + body.slice(0, 60)).toMatch(/\bcallback:/);
			expect(body, "a gated command using checkCallback: " + body.slice(0, 60)).not.toMatch(
				/\bcheckCallback:/
			);
		}
	});
});
