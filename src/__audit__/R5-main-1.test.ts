/**
 * R5-main-1 probe (audit of 1.4.21, tag 1a05f62c). Read-only audit probe.
 *
 * Runs the REAL "Toolbar on / off" callback: the registration block is sliced out of main.ts exactly as
 * src/inline/BarsToggleCommand.test.ts does it, compiled, and handed the real PenToolsMode setters and the real
 * RoutineNotices gate. Only the strip fan-out (refreshPenToolsAll), the detached save and the Notice are recorded.
 *
 * "Is the strip on screen" is the exact expression InkOverlay.ts:2811 / PdfInkController.ts:1071 / SlidesTools.ts:125
 * evaluate: penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession()), with isMobileApp=false
 * (desktop).
 *
 * The cells assert the CORRECT behavior, so they go red only if the bug is real.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import {
	getPenToolsMode,
	markPenHardwareSeen,
	penSeenThisSession,
	penToolsVisible,
	resetPenToolsForTest,
	restorePenHardwareEverSeenFromStore,
	setPenHardwareStore,
	setPenToolsMode,
} from "../inline/PenToolsMode";
import { setNoteZoomControlsMode } from "../inline/NoteZoomControlsMode";
import { routineNoticesVisible } from "../diag/RoutineNotices";

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

const DESKTOP = false; // Platform.isMobileApp on Windows/macOS/Linux

function stripOnScreen(): boolean {
	return penToolsVisible(getPenToolsMode(), DESKTOP, penSeenThisSession());
}

function register() {
	const saves: Settings[] = [];
	const notices: string[] = [];
	let spec: Spec | null = null;
	const plugin = {
		// main.ts:553/:555 defaults
		settings: { penTools: "auto", noteZoomControls: "auto", barsRestore: null } as Settings,
		persistSettings(this: { settings: Settings }): Promise<void> {
			saves.push(JSON.parse(JSON.stringify(this.settings)) as Settings);
			return Promise.resolve();
		},
		addCommand(s: Spec): void {
			spec = s;
		},
	};
	const deps: Record<string, unknown> = {
		setPenToolsMode,
		setNoteZoomControlsMode,
		// The command decides from what is on screen: the real rule, on a desktop platform.
		penToolsVisible,
		penSeenThisSession,
		Platform: { isMobileApp: DESKTOP },
		refreshPenToolsAll: (): void => {},
		runDetached: (_p: Promise<void>, _what: string): void => {},
		routineNoticesVisible, // the REAL gate, default false (RoutineNotices.ts:28)
		Notice: class {
			constructor(message: string) {
				notices.push(message);
			}
		},
	};
	const code = transformSync(`return function () { ${block()} }`, { loader: "ts", target: "es2022" }).code;
	const registrar = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (this: unknown) => void;
	registrar.call(plugin);
	expect(spec, "the block registered a command").not.toBeNull();
	return { plugin, spec: spec as unknown as Spec, saves, notices };
}

/** main.ts:5371-5372 at load: restore the latch from the device store (a pen was used here before), then apply the setting. */
function desktopLaunchWithDefaults(): void {
	setPenHardwareStore({ load: () => "true", save: () => {} });
	restorePenHardwareEverSeenFromStore();
	setPenToolsMode("auto");
}

function assertPrecondition(): void {
	expect(getPenToolsMode(), "PRECONDITION: default Toolbar visibility is auto").toBe("auto");
	expect(penSeenThisSession(), "PRECONDITION: load leaves penSeen false (no pen contact yet this session)").toBe(false);
	expect(stripOnScreen(), "PRECONDITION: desktop, auto, no pen yet -> strip NOT on screen").toBe(false);
	expect(routineNoticesVisible(), "PRECONDITION: routine notices are hidden by default").toBe(false);
}

beforeEach(() => {
	resetPenToolsForTest();
	setNoteZoomControlsMode("auto");
});

describe("R5-main-1: Toolbar on / off on desktop before any pen contact", () => {
	it("CONTROL (no command run): the pen's arrival raises the strip under default auto", () => {
		desktopLaunchWithDefaults();
		assertPrecondition();
		markPenHardwareSeen();
		expect(stripOnScreen(), "control: pen contact raises the strip").toBe(true);
	});

	it("first press, with the strip not on screen, brings the strip up (the command is the way to show it)", () => {
		desktopLaunchWithDefaults();
		assertPrecondition();
		const r = register();
		r.spec.callback();
		expect(stripOnScreen(), `after first press: strip on screen? settings.penTools=${r.plugin.settings.penTools}, saved=${JSON.stringify(r.saves)}, notices=${JSON.stringify(r.notices)}`).toBe(true);
	});

	it("first press does not save 'hide' for a strip that was not on screen, so the pen's arrival still raises it", () => {
		desktopLaunchWithDefaults();
		assertPrecondition();
		const r = register();
		r.spec.callback();
		expect.soft(r.saves.at(-1)?.penTools, "saved Toolbar visibility after one press (data.json)").not.toBe("hide");
		markPenHardwareSeen();
		expect(penSeenThisSession(), "the pen did arrive").toBe(true);
		expect(stripOnScreen(), `pen arrived after one press: strip on screen? mode=${getPenToolsMode()}`).toBe(true);
	});

	it("before the pen arrives the presses alternate from what is on screen: up, down, up", () => {
		// The fix contract: off screen, a press shows; on screen, a press hides and remembers.
		desktopLaunchWithDefaults();
		assertPrecondition();
		const r = register();
		const seen: boolean[] = [];
		for (let i = 0; i < 3; i++) {
			r.spec.callback();
			seen.push(stripOnScreen());
		}
		expect(seen, `strip on screen after each press; saved=${JSON.stringify(r.saves.map((s) => s.penTools))}`).toEqual([true, false, true]);
		expect(r.plugin.settings.barsRestore, "the third press restored and cleared the memory").toBeNull();
	});
});
