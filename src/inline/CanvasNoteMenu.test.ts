/**
 * The two ways a user sets one note's Infinite Canvas: the three-dot menu
 * beside "Paper background", and the command.
 *
 * Both are registered in main.ts, so both are sliced out of main.ts's source
 * (each marker proven present and unique), with the choice they both write
 * sliced out of view/HeaderActions.ts, compiled, and run against fakes -
 * `BarsToggleCommand.test.ts`'s harness, for its reason: the behaviour that
 * ships is the block main.ts registers, not a copy of it written here.
 *
 * What these cells are for: the menu is ONE line with a tick (Alan, 09:4xZ:
 * three lines is too many), the tick has to read the note's real mode rather
 * than whether it holds an override, a click has to write the opposite of what
 * the tick shows, and the notice must never announce a choice the note did not
 * take. The third value, "use the setting", is the command's.
 */
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import onloadSource from "../PluginOnload.ts?raw";
import commandsSource from "../commands/RegisterCommands.ts?raw";
import headerSource from "../view/HeaderActions.ts?raw";

// The command registrations live in commands/RegisterCommands.ts, read here with main.ts.
// The onload phases live in PluginOnload.ts, read here too.
const source = [mainSource, commandsSource, onloadSource].join("\n").replace(/\r\n/g, "\n");
const header = headerSource.replace(/\r\n/g, "\n");

type Choice = true | false | "default";
type Item = {
	setTitle(t: string): Item;
	setIcon(i: string): Item;
	setChecked(c: boolean): Item;
	onClick(fn: () => void): Item;
};
type Recorded = { title: string; checked: boolean; click: () => void };

function slice(start: string, end: string, text: string = source): string {
	expect(text.split(start), `${start} appears once`).toHaveLength(2);
	const at = text.indexOf(start);
	const stop = text.indexOf(end, at);
	expect(stop).toBeGreaterThan(at);
	return text.slice(at, stop + end.length);
}

const MENU = (): string =>
	slice('\t\tthis.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {', "\n\t\t}));");
const COMMAND = (): string =>
	slice('\t\tthis.addCommand({\n\t\t\tid: "canvas-note-override-cycle",', "\n\t\t});");
const WRITER = (): string =>
	slice("\tfunction applyCanvasChoice(this: HandwritingPlugin, path: string, choice: NoteCanvasChoice): void {", "\n\t}", header);

/** A markdown file, as `file instanceof TFile && extension === "md"` sees it. */
class FakeFile {
	constructor(public path: string, public extension = "md") {}
}

function harness(opts: { choice?: Choice; written?: boolean; throws?: boolean; global?: boolean } = {}) {
	const notices: string[] = [];
	const saved: { path: string; choice: Choice }[] = [];
	let refreshes = 0;
	const items: Recorded[] = [];
	let commandSpec: { id: string; name: string; checkCallback(checking: boolean): boolean } | null = null;
	let activeFile: FakeFile | null = new FakeFile("note.md");

	const plugin = {
		settings: { extendCanvasWhileScrolling: opts.global === true },
		canvasOverride: {
			choice: (): Choice => opts.choice ?? "default",
			saveForPath: async (path: string, choice: Choice): Promise<boolean> => {
				if (opts.throws) throw new Error("vault said no");
				saved.push({ path, choice });
				return opts.written ?? true;
			},
		},
		app: {
			workspace: {
				on: (_event: string, handler: unknown) => handler,
				getActiveFile: (): FakeFile | null => activeFile,
			},
		},
		registerEvent: (handler: unknown): unknown => handler,
		addCommand: (spec: typeof commandSpec): void => { commandSpec = spec; },
		applyCanvasChoice: undefined as unknown,
	};

	// The writer fires its work through runDetached and returns void; the harness keeps the last
	// detached promise so a cell can await what the user would eventually be told.
	let lastDetached: Promise<void> = Promise.resolve();
	const deps: Record<string, unknown> = {
		TFile: FakeFile,
		// The module getter the menu resolves the tick with: the note's own
		// value when it has one, the setting when it does not - the real
		// CanvasNoteOverride.ts answer, restated here as a fake so a cell can
		// set both halves.
		canvasForNote: (path: string, globalDefault: boolean): boolean => {
			void path;
			const choice = opts.choice ?? "default";
			return choice === "default" ? globalDefault : choice;
		},
		refreshNoteZoomControlsAll: (): void => { refreshes++; },
		// Awaited here, unlike the real one: these cells are about what the
		// user is told after the write lands, which a fire-and-forget would
		// race.
		runDetached: (work: Promise<unknown>, _what: string, onFailure?: (e: unknown) => void): Promise<void> =>
			(lastDetached = work.then(() => undefined).catch((e: unknown) => { onFailure?.(e); })),
		Notice: class { constructor(message: string) { notices.push(message); } },
	};

	const build = (body: string, args: string[] = []) => {
		const code = transformSync(`return function (${args.join(", ")}) { ${body} }`, { loader: "ts", target: "es2022" }).code;
		return new Function(...Object.keys(deps), code)(...Object.values(deps)) as (this: unknown, ...a: unknown[]) => unknown;
	};

	// The writer first: both routes call it, so it has to be on the object
	// before either of them runs.
	const writer = build(`return (${WRITER().replace("function applyCanvasChoice(this: HandwritingPlugin, path: string, choice: NoteCanvasChoice): void {", "function (path, choice) {")})`);
	plugin.applyCanvasChoice = (writer.call(plugin) as (this: unknown, p: string, c: Choice) => Promise<void> | void);
	const call = plugin.applyCanvasChoice as (p: string, c: Choice) => Promise<void>;
	plugin.applyCanvasChoice = function (this: unknown, p: string, c: Choice) { return call.call(plugin, p, c); };

	return {
		notices, saved, items, plugin,
		refreshes: (): number => refreshes,
		setActive: (f: FakeFile | null): void => { activeFile = f; },
		write: async (path: string, choice: Choice): Promise<void> => {
			await (plugin.applyCanvasChoice as (p: string, c: Choice) => Promise<void> | void)(path, choice);
			await lastDetached;
		},
		openMenu(file: FakeFile | { path: string; extension: string }): Recorded[] {
			// The sliced block is a statement; the handler it registers comes back only if the block is returned.
			const registrar = build("return " + MENU());
			const handler = registrar.call(plugin) as unknown;
			const menu = {
				addItem(build2: (item: Item) => void): void {
					const rec: Recorded = { title: "", checked: false, click: () => {} };
					const item: Item = {
						setTitle(t) { rec.title = t; return item; },
						setIcon() { return item; },
						setChecked(c) { rec.checked = c; return item; },
						onClick(fn) { rec.click = fn; return item; },
					};
					build2(item);
					items.push(rec);
				},
			};
			(handler as (m: typeof menu, f: unknown) => void).call(plugin, menu, file);
			return items;
		},
		runCommand(checking: boolean): boolean {
			const registrar = build(COMMAND());
			registrar.call(plugin);
			expect(commandSpec, "the block registered a command").not.toBeNull();
			return commandSpec!.checkCallback(checking);
		},
	};
}

describe("the three-dot menu for one note's Infinite Canvas", () => {
	it("is ONE line, beside the paper item", () => {
		const h = harness();
		expect(h.openMenu(new FakeFile("note.md")).map(i => i.title)).toEqual(["Infinite canvas"]);
	});

	/**
	 * THE TICK IS THE NOTE'S REAL MODE, not "this note has an override". A
	 * reader of this menu wants to know whether the note in front of them is a
	 * canvas; a tick that meant "overridden" would be off on every untouched
	 * note, including every note that IS a canvas because the setting says so.
	 */
	it.each([
		["override on, setting off", true as Choice, false, true],
		["override off, setting on", false as Choice, true, false],
		["no override, setting on", "default" as Choice, true, true],
		["no override, setting off", "default" as Choice, false, false],
	])("%s: ticked = %s", (_name, choice, global, ticked) => {
		const h = harness({ choice, global });
		expect(h.openMenu(new FakeFile("note.md"))[0]!.checked).toBe(ticked);
	});

	it("offers nothing for a file that is not a markdown note", () => {
		const h = harness();
		expect(h.openMenu({ path: "scan.pdf", extension: "pdf" })).toEqual([]);
	});

	/**
	 * A click always writes an EXPLICIT value, never "default": the click
	 * means "I want this note the other way", and the only way to say that
	 * about a note whose mode came from the setting is to write the opposite
	 * down. Going back to following the setting is the command's job.
	 */
	it.each([
		["a canvas note is turned off", true as Choice, false, false as Choice],
		["a plain note is turned on", false as Choice, true, true as Choice],
		["an untouched note on a canvas vault is turned off", "default" as Choice, true, false as Choice],
		["an untouched note on a plain vault is turned on", "default" as Choice, false, true as Choice],
	])("%s", async (_name, choice, global, written) => {
		const h = harness({ choice, global });
		h.openMenu(new FakeFile("note.md"))[0]!.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(h.saved).toEqual([{ path: "note.md", choice: written }]);
	});
});

describe("writing one note's Infinite Canvas", () => {
	it("tells the user what landed, and only after it landed", async () => {
		const h = harness();
		await h.write("note.md", true);
		expect(h.saved).toEqual([{ path: "note.md", choice: true }]);
		expect(h.notices).toEqual(["Handwriting: Infinite canvas on for this note"]);
		expect(h.refreshes(), "the open zoom bars are re-asked").toBe(1);
	});

	it("names the setting's own value when the note goes back to the default", async () => {
		const on = harness({ global: true });
		await on.write("note.md", "default");
		expect(on.notices).toEqual(["Handwriting: Infinite canvas follows the setting (on)"]);
		const off = harness({ global: false });
		await off.write("note.md", "default");
		expect(off.notices).toEqual(["Handwriting: Infinite canvas follows the setting (off)"]);
	});

	it("a note that is gone is said so, and nothing is repainted", async () => {
		const h = harness({ written: false });
		await h.write("gone.md", true);
		expect(h.notices).toEqual(["Handwriting: that note is gone - infinite canvas not changed"]);
		expect(h.refreshes(), "no repaint on a write that did not happen").toBe(0);
	});

	it("a write that throws says so instead of announcing the choice", async () => {
		const h = harness({ throws: true });
		await h.write("note.md", false);
		expect(h.notices).toEqual(["Handwriting: could not write infinite canvas to that note"]);
		expect(h.refreshes()).toBe(0);
	});
});

describe("the Infinite Canvas command", () => {
	it("cycles default -> on -> off -> default", async () => {
		for (const [from, to] of [["default", true], [true, false], [false, "default"]] as const) {
			const h = harness({ choice: from });
			h.runCommand(false);
			await Promise.resolve();
			await Promise.resolve();
			expect(h.saved, `${String(from)} -> ${String(to)}`).toEqual([{ path: "note.md", choice: to }]);
		}
	});

	it("is not offered when there is no markdown note in front of the user", () => {
		const h = harness();
		expect(h.runCommand(true), "with a note").toBe(true);
		h.setActive(null);
		expect(h.runCommand(true), "with nothing open").toBe(false);
		h.setActive(new FakeFile("scan.pdf", "pdf"));
		expect(h.runCommand(true), "with a pdf open").toBe(false);
	});
});
