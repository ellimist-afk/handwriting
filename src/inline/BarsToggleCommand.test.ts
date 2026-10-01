/**
 * The registered "Toolbar on / off" callback, run as main.ts registers it.
 *
 * The canvas work narrowed it: the command used to move BOTH bars, and now moves the toolbar alone. The zoom bar is
 * decided by its own settings row and by Infinite Canvas, so a command that also hid it took a decision away from
 * those two - and with the canvas off the zoom bar is not on screen for this command to restore.
 *
 * The block is sliced out of main.ts (both ends proven present and unique), compiled, and handed the real mode
 * setters; only the strip refresh, the detached save and the notice are recorded instead of run. The zoom bar's own
 * live mode is set before each run and asserted unchanged after it: a callback that kept writing it would otherwise
 * pass every cell about the toolbar.
 */
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import { getPenToolsMode, penToolsVisible, setPenToolsMode } from "./PenToolsMode";
import { getNoteZoomControlsMode, setNoteZoomControlsMode } from "./NoteZoomControlsMode";

const source = mainSource.replace(/\r\n/g, "\n");
const START = '\t\tthis.addCommand({\n\t\t\tid: "toolbar-zoom-bar-toggle",';
const END = "\n\t\t});";

function block(): string {
	expect(source.split(START), "the command's registration is in main.ts once").toHaveLength(2);
	const at = source.indexOf(START);
	const end = source.indexOf(END, at);
	expect(end).toBeGreaterThan(at);
	return source.slice(at, end + END.length);
}

type Settings = { penTools: string; noteZoomControls: string; barsRestore: unknown };
type Spec = { id: string; name: string; callback: () => void };

function register() {
	const saves: Settings[] = [], notices: string[] = [], detached: string[] = [];
	let refreshes = 0;
	let spec: Spec | null = null;
	const plugin = {
		settings: { penTools: "auto", noteZoomControls: "auto", barsRestore: null } as Settings,
		persistSettings(this: { settings: Settings }): Promise<void> {
			saves.push(JSON.parse(JSON.stringify(this.settings)) as Settings);
			return Promise.resolve();
		},
		addCommand(s: Spec): void { spec = s; },
	};
	const deps: Record<string, unknown> = {
		setPenToolsMode, setNoteZoomControlsMode,
		// A pen has been seen, so Auto puts the strip on screen: these cells are about a visible toolbar.
		// The command before any pen contact is src/__audit__/R5-main-1.test.ts.
		penToolsVisible, penSeenThisSession: (): boolean => true, Platform: { isMobileApp: false },
		refreshPenToolsAll: (): void => { refreshes++; },
		runDetached: (_p: Promise<void>, what: string): void => { detached.push(what); },
		routineNoticesVisible: (): boolean => true,
		Notice: class { constructor(message: string) { notices.push(message); } },
	};
	const code = transformSync(`return function () { ${block()} }`, { loader: "ts", target: "es2022" }).code;
	const registrar = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (this: unknown) => void;
	registrar.call(plugin);
	expect(spec, "the block registered a command").not.toBeNull();
	return { plugin, spec: spec as unknown as Spec, saves, notices, detached, refreshes: (): number => refreshes };
}

describe("the command moves the toolbar and nothing else", () => {
	/**
	 * THE ZOOM BAR IS NOT ITS BUSINESS: from every starting pair whose toolbar is showing, Off hides the toolbar and
	 * leaves the zoom bar's setting and live mode exactly as they were, and the On after it puts the toolbar back
	 * where it was. A pair that starts hidden runs the other way round and has its own cell below.
	 */
	const pairs = [["auto", "auto"], ["show", "show"], ["show", "auto"], ["auto", "show"], ["show", "hide"]] as const;
	it.each(pairs)("from %s / %s: Off hides the toolbar only, On puts it back", (pen, zoom) => {
		setPenToolsMode(pen);
		setNoteZoomControlsMode(zoom);
		const r = register();
		r.plugin.settings.penTools = pen;
		r.plugin.settings.noteZoomControls = zoom;

		r.spec.callback();
		expect(r.plugin.settings.penTools, "Off: the toolbar setting").toBe("hide");
		expect(getPenToolsMode(), "Off: the toolbar's live mode").toBe("hide");
		expect(r.plugin.settings.noteZoomControls, "Off: the zoom bar setting is untouched").toBe(zoom);
		expect(getNoteZoomControlsMode(), "Off: the zoom bar's live mode is untouched").toBe(zoom);

		r.spec.callback();
		expect(r.plugin.settings.penTools, "On: the toolbar setting it was hidden from").toBe(pen);
		expect(getPenToolsMode(), "On: the toolbar's live mode").toBe(pen);
		expect(r.plugin.settings.noteZoomControls, "On: the zoom bar setting is still untouched").toBe(zoom);
		expect(getNoteZoomControlsMode(), "On: the zoom bar's live mode is still untouched").toBe(zoom);
	});
});

describe("the Toolbar on / off command", () => {
	it("is named for the one bar it moves, and keeps its id", () => {
		const r = register();
		expect(r.spec.name).toBe("Toolbar on / off");
		expect(r.spec.id, "the id is the hotkey contract and does not move").toBe("toolbar-zoom-bar-toggle");
	});

	it("hides the toolbar live, saves what it hid, and a second run puts it back", () => {
		setPenToolsMode("auto");
		setNoteZoomControlsMode("auto");
		const r = register();

		r.spec.callback();
		expect(r.plugin.settings).toEqual({ penTools: "hide", noteZoomControls: "auto", barsRestore: { penTools: "auto", noteZoomControls: "auto" } });
		expect(getPenToolsMode(), "the live mode the strip reads").toBe("hide");
		expect(r.refreshes(), "the strip is re-created or removed for the new mode").toBe(1);
		expect(r.saves, "the off and its memory are saved").toEqual([{ penTools: "hide", noteZoomControls: "auto", barsRestore: { penTools: "auto", noteZoomControls: "auto" } }]);
		expect(r.detached).toHaveLength(1);
		expect(r.notices).toEqual(["Handwriting: toolbar off"]);

		r.spec.callback();
		expect(r.plugin.settings).toEqual({ penTools: "auto", noteZoomControls: "auto", barsRestore: null });
		expect(getPenToolsMode()).toBe("auto");
		expect(r.refreshes()).toBe(2);
		expect(r.saves.at(-1)).toEqual({ penTools: "auto", noteZoomControls: "auto", barsRestore: null });
		expect(r.notices.at(-1)).toBe("Handwriting: toolbar on");
	});

	/** With the toolbar already hidden by its own row and nothing remembered, the command has to be the way back. */
	it("shows the toolbar from a stored hide with no memory", () => {
		setPenToolsMode("hide");
		setNoteZoomControlsMode("hide");
		const r = register();
		r.plugin.settings.penTools = "hide";
		r.plugin.settings.noteZoomControls = "hide";

		r.spec.callback();
		expect(r.plugin.settings.penTools).toBe("show");
		expect(getPenToolsMode()).toBe("show");
		expect(r.plugin.settings.noteZoomControls, "the zoom bar stays hidden: its own row said so").toBe("hide");
		expect(r.notices.at(-1)).toBe("Handwriting: toolbar on");
	});
});
