import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import {
	endLiveStrokesEverywhere,
	getInlineEraserMode,
	getInlineLassoMode,
	getInlinePanMode,
	getInlineSpaceMode,
	getInlineTool,
	hidePenCursorsEverywhere,
	inkOverlayExtension,
	inlineInk,
	overlayForPath,
	refreshAllStrips,
	refreshPenToolsAll,
	setInlineEraserMode,
	setInlineInkEnabled,
	setInlineLassoMode,
	setInlinePanMode,
	setInlineSpaceMode,
	setInlineTool,
	setInkSizeMult,
} from "../../src/inline/InkOverlay";
import {
	clearGatedCommandActions,
	runGatedCommand,
	setRetiredCommandAction,
} from "../../src/CommandPaletteSplit";
import { clearToolPicked, mouseInkEnabled, setMouseInk, toolPickedHere } from "../../src/inline/MouseInk";
import { PEN_INK_TOGGLE } from "../../src/inline/MobileTools";
import { type PenCommandHost, penOnOff, togglePenInput } from "../../src/inline/PenCommand";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "../../src/inline/PenInk";
import {
	penHardwareSeen,
	markPenSeen,
	resetPenToolsForTest,
	restorePenHardwareEverSeen,
	shouldRaiseStripOnPenOff,
} from "../../src/inline/PenToolsMode";
import { installObsidianDom } from "./obsidianDom";
import {
	type BrowserEditorInfo,
	editorInfoField,
	setBrowserEditorInfo,
} from "./iphoneObsidianStub";

installObsidianDom();

const PATH_A = "acceptance/finger-a.md";
const PATH_A_RENAMED = "acceptance/finger-a-renamed.md";
const PATH_B = "acceptance/finger-b.md";
const PATH_TEARDOWN = "acceptance/finger-teardown.md";
const PATH_KEYBOARD = "acceptance/finger-keyboard.md";
const PATH_REENTRY = "acceptance/finger-reentry.md";
const ALL_PATHS = [
	PATH_A,
	PATH_A_RENAMED,
	PATH_B,
	PATH_TEARDOWN,
	PATH_KEYBOARD,
	PATH_REENTRY,
];

interface MountedNote {
	wrapper: HTMLElement;
	view: EditorView;
	info: BrowserEditorInfo;
	executedCommands: string[];
}

export interface FingerLifecycleTrace {
	route: {
		mountedA: boolean;
		buttonLabels: string[];
		penButtonPresent: boolean;
		penCommandCount: number;
		toolPicked: boolean;
		downPrevented: boolean;
		aAfterDraw: number;
		pressuresAfterDraw: number[];
		widthModeAfterDraw: string | null;
		widthAfterDraw: number | null;
		drawUndoDepth: number;
		mountedB: boolean;
		latePrevented: boolean;
		renamedBeforeUndo: number;
		bBeforeUndo: number;
		undoOk: boolean;
		renamedAfterUndo: number;
		bAfterUndo: number;
		redoOk: boolean;
		renamedAfterRedo: number;
		widthModeAfterRedo: string | null;
		bAfterRedo: number;
	};
	teardown: {
		mounted: boolean;
		downPrevented: boolean;
		storeBeforeDestroy: number;
		routerDownsBeforeDestroy: number;
		overlayAfterDestroy: boolean;
		storeAfterDestroy: number;
		lateDownPrevented: boolean;
		storeAfterLateEvents: number;
	};
	keyboard: {
		mounted: boolean;
		keyboardButtonPresent: boolean;
		downPrevented: boolean;
		storeBeforeClick: number;
		keyboardRuns: number;
		penInkAfterClick: boolean;
		toolPickedAfterClick: boolean;
		editorFocused: boolean;
		storeAfterClick: number;
		historyAfterClick: number;
		storeAfterLateUp: number;
		freshDownPrevented: boolean;
		storeAfterFreshTouch: number;
		mousePreferenceBefore: boolean;
		mousePreferenceAfterClick: boolean;
		mouseNibBefore: string;
		mouseNibAfterClick: string;
		mouseStrokeBeforeKeyboard: number;
		mouseDownPrevented: boolean;
		mouseUpPrevented: boolean;
		mouseLateUpPrevented: boolean;
		mouseStoreAfterClick: number;
		mouseFreshDownPrevented: boolean;
		mouseFreshStore: number;
		mouseHeldStoreAfterCommand: number;
		mouseHeldRouterStrokingAfterCommand: boolean;
		mouseHeldStoreAfterUp: number;
		mouseHeldRouterStrokingAfterUp: boolean;
		mousePostHeldDownPrevented: boolean;
		mousePostHeldStore: number;
		mouseHoverClassWhilePaused: boolean;
		mousePreferenceAfterResume: boolean;
		mouseNibAfterResume: string;
		mouseResumeDownPrevented: boolean;
		mouseResumeStore: number;
	};
	reentry: {
		mounted: boolean;
		touchActionAfterPenWhileHeld: string;
		touchActionAfterHeldLift: string;
		touchActionAfterCompletedScroll: string;
		touchActionAfterCommand: string;
		litReselectPrepareCalls: number;
		touchActionAfterPointerCancel: string;
		touchActionAfterNativeCancel: string;
		touchActionAfterHighlighterScroll: string;
		touchActionAfterHighlighter: string;
		penCommandCount: number;
		highlighterCommandCount: number;
		penInkAfterPen: boolean;
		toolPickedAfterPen: boolean;
		toolAfterHighlighter: string;
		downPrevented: boolean;
		storeAfterDraw: number;
	};
}

let keyboardRuns = 0;

const commandHost: PenCommandHost = {
	tool: () => getInlineTool(),
	tipMode: () =>
		getInlineEraserMode() ||
		getInlineLassoMode() ||
		getInlineSpaceMode() ||
		getInlinePanMode(),
	pickPen: () => {
		setInlineTool("pen");
		setInlineEraserMode(false);
		setInlineLassoMode(false);
		setInlineSpaceMode(false);
		setInlinePanMode(false);
	},
	afterFlip: (on) => {
		// This is the shipped main.ts fan-out, in the shipped order.
		endLiveStrokesEverywhere(!on);
		if (on || shouldRaiseStripOnPenOff(penHardwareSeen())) markPenSeen();
		refreshPenToolsAll();
		refreshAllStrips();
		if (!on) hidePenCursorsEverywhere();
	},
};

function resetSession(): void {
	for (const path of ALL_PATHS) inlineInk.handleDelete(path);
	clearGatedCommandActions();
	setMouseInk(false);
	resetPenInkForTest();
	resetPenToolsForTest();
	clearToolPicked();
	setInlineInkEnabled(true);
	setInlineEraserMode(false);
	setInlineLassoMode(false);
	setInlineSpaceMode(false);
	setInlinePanMode(false);
	setInkSizeMult("pen", 1);
	setInkSizeMult("highlighter", 1);
	// A prior genuine pen sighting is what makes the Keyboard control part of
	// the real mobile strip. Restore the durable latch without pretending a
	// pen contact happened or granting finger ink.
	restorePenHardwareEverSeen();
	keyboardRuns = 0;
	setRetiredCommandAction(PEN_INK_TOGGLE, () => {
		keyboardRuns++;
		togglePenInput(commandHost);
	});
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function mount(path: string): Promise<MountedNote> {
	const wrapper = document.body.appendChild(document.createElement("div"));
	wrapper.className = "markdown-source-view";
	wrapper.style.cssText = "position:relative;width:393px;height:720px;overflow:hidden";
	const executedCommands: string[] = [];
	const editor = {};
	let info!: BrowserEditorInfo;
	const app = {
		commands: {
			executeCommandById(id: string): boolean {
				executedCommands.push(id);
				if (id === "handwriting:inline-tool-pen") {
					penOnOff(commandHost);
					return true;
				}
				if (id === "handwriting:inline-tool-highlighter") {
					// Match main.ts: the Highlighter command selects its nib but
					// does not enable pen input. MobileTools does that after exec.
					markPenSeen();
					refreshPenToolsAll();
					setInlineTool("highlighter");
					setInlineEraserMode(false);
					setInlineLassoMode(false);
					setInlineSpaceMode(false);
					setInlinePanMode(false);
					return true;
				}
				if (id === PEN_INK_TOGGLE) {
					togglePenInput(commandHost);
					return true;
				}
				return false;
			},
		},
	};
	info = { app, file: { path }, editor };
	const view = new EditorView({
		parent: wrapper,
		state: EditorState.create({
			doc: Array.from({ length: 80 }, (_, i) => `${i + 1}: ordinary note text`).join("\n"),
			extensions: [
				history(),
				editorInfoField.init(() => info),
				inkOverlayExtension(),
				EditorView.theme({
					"&": { height: "700px", width: "390px" },
					".cm-scroller": { overflow: "auto" },
					".cm-content": {
						fontFamily: "sans-serif",
						fontSize: "16px",
						lineHeight: "24px",
						minHeight: "1900px",
					},
				}),
			],
		}),
	});
	await settle();
	return { wrapper, view, info, executedCommands };
}

function switchPath(note: MountedNote, path: string): void {
	note.info = { ...note.info, file: { path } };
	note.view.dispatch({ effects: setBrowserEditorInfo.of(note.info) });
}

function touch(
	target: HTMLElement,
	type: string,
	pointerId: number,
	x: number,
	y: number,
	buttons: number
): PointerEvent {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerType: "touch",
		pointerId,
		isPrimary: true,
		clientX: x,
		clientY: y,
		buttons,
		pressure: buttons === 0 ? 0 : 0.87,
	});
	target.dispatchEvent(event);
	return event;
}

function mouse(
	target: HTMLElement,
	type: string,
	pointerId: number,
	x: number,
	y: number,
	buttons: number
): PointerEvent {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerType: "mouse",
		pointerId,
		isPrimary: true,
		clientX: x,
		clientY: y,
		buttons,
		pressure: buttons === 0 ? 0 : 0.5,
	});
	target.dispatchEvent(event);
	return event;
}

/** The parallel WebKit touch ledger, whose ids are not pointer ids. */
function nativeTouch(target: HTMLElement, type: "touchstart" | "touchcancel", identifier: number): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	// A real TouchEvent always carries the fingers still down; the router reads
	// touches.length on touchend and touchcancel.
	Object.defineProperty(event, "touches", {
		value: type === "touchstart" ? [{ identifier, radiusX: 5, radiusY: 5 }] : [],
	});
	Object.defineProperty(event, "changedTouches", {
		value: [{ identifier, radiusX: 5, radiusY: 5 }],
	});
	target.dispatchEvent(event);
	return event;
}

function toolbarButton(root: HTMLElement, label: string): HTMLButtonElement | null {
	return (
		[...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
			const actual = button.dataset.tipLabel ?? button.getAttribute("aria-label");
			return (
				actual === label ||
				((label === "Pen" || label === "Highlighter") && actual?.startsWith(`${label}: `))
			);
		}) ?? null
	);
}

function toolbarLabels(root: HTMLElement): string[] {
	return [...root.querySelectorAll<HTMLButtonElement>("button")].map(
		(button) => button.dataset.tipLabel ?? button.getAttribute("aria-label") ?? ""
	);
}

function pressToolbarButton(button: HTMLButtonElement): PointerEvent {
	const event = new PointerEvent("click", {
		bubbles: true,
		cancelable: true,
		pointerType: "touch",
		pointerId: 900,
		isPrimary: true,
		buttons: 0,
	});
	button.dispatchEvent(event);
	return event;
}

async function routeTrace(): Promise<FingerLifecycleTrace["route"]> {
	const note = await mount(PATH_A);
	try {
		const mountedA = overlayForPath(PATH_A) !== null;
		const pen = toolbarButton(note.wrapper, "Pen");
		if (pen) pressToolbarButton(pen);
		await settle();
		const down = touch(note.view.contentDOM, "pointerdown", 11, 70, 130, 1);
		touch(note.view.contentDOM, "pointermove", 11, 115, 155, 1);
		touch(note.view.contentDOM, "pointermove", 11, 165, 180, 1);
		touch(note.view.contentDOM, "pointerup", 11, 165, 180, 0);
		await settle();
		const aAfterDraw = inlineInk.strokes(PATH_A).length;
		const widthModeAfterDraw = inlineInk.strokes(PATH_A)[0]?.widthMode ?? null;
		const widthAfterDraw = inlineInk.strokes(PATH_A)[0]?.width ?? null;
		const pressuresAfterDraw = [
			...new Set(
				inlineInk
					.strokes(PATH_A)
					.flatMap((stroke) => stroke.points.map((point) => point.pressure))
			),
		];
		const drawUndoDepth = undoDepth(note.view.state);

		switchPath(note, PATH_B);
		await settle();
		const mountedB = overlayForPath(PATH_B) !== null;
		const lateMove = touch(note.view.contentDOM, "pointermove", 11, 190, 190, 1);
		touch(note.view.contentDOM, "pointerup", 11, 190, 190, 0);
		await settle();

		// Move the record after the history step was written. Undo/redo must
		// resolve the recorded session identity, not the stale original path.
		inlineInk.handleRename(PATH_A, PATH_A_RENAMED);
		const renamedBeforeUndo = inlineInk.strokes(PATH_A_RENAMED).length;
		const bBeforeUndo = inlineInk.strokes(PATH_B).length;
		const undoOk = undo(note.view);
		await settle();
		const renamedAfterUndo = inlineInk.strokes(PATH_A_RENAMED).length;
		const bAfterUndo = inlineInk.strokes(PATH_B).length;
		const redoOk = redo(note.view);
		await settle();

		return {
			mountedA,
			buttonLabels: toolbarLabels(note.wrapper),
			penButtonPresent: pen !== null,
			penCommandCount: note.executedCommands.filter(
				(id) => id === "handwriting:inline-tool-pen"
			).length,
			toolPicked: toolPickedHere(),
			downPrevented: down.defaultPrevented,
			aAfterDraw,
			pressuresAfterDraw,
			widthModeAfterDraw,
			widthAfterDraw,
			drawUndoDepth,
			mountedB,
			latePrevented: lateMove.defaultPrevented,
			renamedBeforeUndo,
			bBeforeUndo,
			undoOk,
			renamedAfterUndo,
			bAfterUndo,
			redoOk,
			renamedAfterRedo: inlineInk.strokes(PATH_A_RENAMED).length,
			widthModeAfterRedo: inlineInk.strokes(PATH_A_RENAMED)[0]?.widthMode ?? null,
			bAfterRedo: inlineInk.strokes(PATH_B).length,
		};
	} finally {
		note.view.destroy();
		note.wrapper.remove();
		inlineInk.handleDelete(PATH_A);
		inlineInk.handleDelete(PATH_A_RENAMED);
		inlineInk.handleDelete(PATH_B);
	}
}

async function teardownTrace(): Promise<FingerLifecycleTrace["teardown"]> {
	const note = await mount(PATH_TEARDOWN);
	const content = note.view.contentDOM;
	const overlay = overlayForPath(PATH_TEARDOWN);
	try {
		const down = touch(content, "pointerdown", 21, 65, 145, 1);
		touch(content, "pointermove", 21, 125, 180, 1);
		const storeBeforeDestroy = inlineInk.strokes(PATH_TEARDOWN).length;
		const routerDownsBeforeDestroy = overlay?.routerCounters().downs ?? -1;
		note.view.destroy();
		const overlayAfterDestroy = overlayForPath(PATH_TEARDOWN) !== null;
		const storeAfterDestroy = inlineInk.strokes(PATH_TEARDOWN).length;
		const lateDown = touch(content, "pointerdown", 22, 80, 160, 1);
		touch(content, "pointerup", 21, 125, 180, 0);
		touch(content, "pointerup", 22, 80, 160, 0);
		await settle();
		return {
			mounted: overlay !== null,
			downPrevented: down.defaultPrevented,
			storeBeforeDestroy,
			routerDownsBeforeDestroy,
			overlayAfterDestroy,
			storeAfterDestroy,
			lateDownPrevented: lateDown.defaultPrevented,
			storeAfterLateEvents: inlineInk.strokes(PATH_TEARDOWN).length,
		};
	} finally {
		// destroy is idempotent, and keeps cleanup correct if an assertion
		// above throws before the deliberate mid-stroke destroy.
		note.view.destroy();
		note.wrapper.remove();
		inlineInk.handleDelete(PATH_TEARDOWN);
	}
}

async function keyboardTrace(): Promise<FingerLifecycleTrace["keyboard"]> {
	const note = await mount(PATH_KEYBOARD);
	try {
		const keyboard = toolbarButton(note.wrapper, "Keyboard mode (pen input off)");
		const overlay = overlayForPath(PATH_KEYBOARD);
		const down = touch(note.view.contentDOM, "pointerdown", 31, 75, 150, 1);
		touch(note.view.contentDOM, "pointermove", 31, 130, 185, 1);
		const storeBeforeClick = inlineInk.strokes(PATH_KEYBOARD).length;
		if (keyboard) pressToolbarButton(keyboard);
		await settle();
		const storeAfterClick = inlineInk.strokes(PATH_KEYBOARD).length;
		const historyAfterClick = undoDepth(note.view.state);
		touch(note.view.contentDOM, "pointerup", 31, 130, 185, 0);
		await settle();
		const storeAfterLateUp = inlineInk.strokes(PATH_KEYBOARD).length;
		const freshDown = touch(note.view.contentDOM, "pointerdown", 32, 90, 170, 1);
		touch(note.view.contentDOM, "pointerup", 32, 90, 170, 0);
		await settle();
		const storeAfterFreshTouch = inlineInk.strokes(PATH_KEYBOARD).length;
		const penInkAfterClick = penInkEnabled();
		const toolPickedAfterClick = toolPickedHere();
		const editorFocused = note.view.hasFocus;
		const keyboardRunsAfterTouch = keyboardRuns;

		// The same mounted editor now exercises the approved Surface Keyboard
		// mouse pause. Keep an explicit Mouse preference and a nominal
		// highlighter, then enter Keyboard through the real toolbar while idle.
		// The registered command seam is exercised separately while a mouse
		// stroke is held, because ownership correctly suppresses that click.
		setPenInk(true);
		setMouseInk(true);
		const highlighterChoice = toolbarButton(note.wrapper, "Highlighter");
		if (!highlighterChoice) throw new Error("missing mounted Highlighter control");
		pressToolbarButton(highlighterChoice);
		await settle();
		const mouseKeyboard = toolbarButton(note.wrapper, "Keyboard mode (pen input off)");
		if (!mouseKeyboard) throw new Error("missing refreshed Keyboard control");
		const mousePreferenceBefore = mouseInkEnabled();
		const mouseNibBefore = getInlineTool();
		const mouseDown = mouse(note.view.contentDOM, "pointerdown", 71, 80, 155, 1);
		mouse(note.view.contentDOM, "pointermove", 71, 120, 180, 1);
		const mouseUp = mouse(note.view.contentDOM, "pointerup", 71, 120, 180, 0);
		await settle();
		const mouseStrokeBeforeKeyboard = inlineInk.strokes(PATH_KEYBOARD).length - storeAfterFreshTouch;
		pressToolbarButton(mouseKeyboard);
		await settle();
		const mouseStoreAfterClick = inlineInk.strokes(PATH_KEYBOARD).length;
		const mousePreferenceAfterClick = mouseInkEnabled();
		const mouseNibAfterClick = getInlineTool();
		const mouseFreshDown = mouse(note.view.contentDOM, "pointerdown", 72, 100, 175, 1);
		mouse(note.view.contentDOM, "pointermove", 72, 120, 195, 1);
		mouse(note.view.contentDOM, "pointerup", 72, 120, 195, 0);
		await settle();
		const mouseHoverClassWhilePaused = note.view.scrollDOM.classList.contains("handwriting-pen-hover");
		const mouseStoreWhilePaused = inlineInk.strokes(PATH_KEYBOARD).length;
		const keyboardResume = toolbarButton(note.wrapper, "Keyboard mode (pen input off)");
		if (!keyboardResume) throw new Error("missing Keyboard resume control");
		pressToolbarButton(keyboardResume);
		await settle();
		mouse(note.view.contentDOM, "pointerdown", 73, 105, 180, 1);
		mouse(note.view.contentDOM, "pointermove", 73, 140, 205, 1);
		if (!runGatedCommand(PEN_INK_TOGGLE) || penInkEnabled()) {
			throw new Error("registered Keyboard command did not pause pen input");
		}
		const mouseHeldStoreAfterCommand = inlineInk.strokes(PATH_KEYBOARD).length;
		const mouseHeldRouterStrokingAfterCommand =
			((overlay as unknown as { router?: { isStroking: boolean } }).router?.isStroking ?? false);
		await settle();
		const mouseLateUp = mouse(note.view.contentDOM, "pointerup", 73, 140, 205, 0);
		await settle();
		const mouseHeldStoreAfterUp = inlineInk.strokes(PATH_KEYBOARD).length;
		const mouseHeldRouterStrokingAfterUp =
			((overlay as unknown as { router?: { isStroking: boolean } }).router?.isStroking ?? false);
		const mousePostHeldDown = mouse(note.view.contentDOM, "pointerdown", 74, 110, 185, 1);
		mouse(note.view.contentDOM, "pointerup", 74, 110, 185, 0);
		await settle();
		const mousePostHeldStore = inlineInk.strokes(PATH_KEYBOARD).length;
		const mouseResume = toolbarButton(note.wrapper, "Highlighter");
		if (!mouseResume) throw new Error("missing Highlighter resume control after held stroke");
		pressToolbarButton(mouseResume);
		await settle();
		const mouseResumeDown = mouse(note.view.contentDOM, "pointerdown", 75, 105, 180, 1);
		mouse(note.view.contentDOM, "pointermove", 75, 140, 205, 1);
		mouse(note.view.contentDOM, "pointerup", 75, 140, 205, 0);
		await settle();
		const mousePreferenceAfterResume = mouseInkEnabled();
		const mouseNibAfterResume = getInlineTool();
		// Leave the mounted fixture in Keyboard mode for the existing re-entry
		// trace, while keeping the explicit Mouse preference armed.
		const finalKeyboard = toolbarButton(note.wrapper, "Keyboard mode (pen input off)");
		if (!finalKeyboard) throw new Error("missing final Keyboard control");
		pressToolbarButton(finalKeyboard);
		return {
			mounted: overlay !== null,
			keyboardButtonPresent: keyboard !== null,
			downPrevented: down.defaultPrevented,
			storeBeforeClick,
			keyboardRuns: keyboardRunsAfterTouch,
			penInkAfterClick,
			toolPickedAfterClick,
			editorFocused,
			storeAfterClick,
			historyAfterClick,
			storeAfterLateUp,
			freshDownPrevented: freshDown.defaultPrevented,
			storeAfterFreshTouch,
			mousePreferenceBefore,
			mousePreferenceAfterClick,
			mouseNibBefore,
			mouseNibAfterClick,
			mouseStrokeBeforeKeyboard,
			mouseDownPrevented: mouseDown.defaultPrevented,
			mouseUpPrevented: mouseUp.defaultPrevented,
			mouseLateUpPrevented: mouseLateUp.defaultPrevented,
			mouseStoreAfterClick,
			mouseFreshDownPrevented: mouseFreshDown.defaultPrevented,
			mouseFreshStore: mouseStoreWhilePaused,
			mouseHeldStoreAfterCommand,
			mouseHeldRouterStrokingAfterCommand,
			mouseHeldStoreAfterUp,
			mouseHeldRouterStrokingAfterUp,
			mousePostHeldDownPrevented: mousePostHeldDown.defaultPrevented,
			mousePostHeldStore,
			mouseHoverClassWhilePaused,
			mousePreferenceAfterResume,
			mouseNibAfterResume,
			mouseResumeDownPrevented: mouseResumeDown.defaultPrevented,
			mouseResumeStore: inlineInk.strokes(PATH_KEYBOARD).length,
		};
	} finally {
		note.view.destroy();
		note.wrapper.remove();
		inlineInk.handleDelete(PATH_KEYBOARD);
	}
}

/**
 * The physical iPhone failure's entry orderings. The browser snapshots
 * touch-action before pointerdown, so every assertion reads the guard after
 * entry has settled and before the next drawing contact.
 */
async function reentryTrace(): Promise<FingerLifecycleTrace["reentry"]> {
	const note = await mount(PATH_REENTRY);
	try {
		const overlay = overlayForPath(PATH_REENTRY);
		const pen = toolbarButton(note.wrapper, "Pen");
		const keyboard = toolbarButton(note.wrapper, "Keyboard mode (pen input off)");
		if (!overlay || !pen || !keyboard) throw new Error("missing re-entry surface or controls");

		// Keyboard mode was left on by keyboardTrace. Keep the scrolling finger
		// down while another finger chooses Pen: preparation must defer rather
		// than rewriting the guard underneath the gesture.
		touch(note.view.contentDOM, "pointerdown", 41, 100, 240, 1);
		touch(note.view.contentDOM, "pointermove", 41, 100, 160, 1);
		pressToolbarButton(pen);
		const touchActionAfterPenWhileHeld = note.view.scrollDOM.style.touchAction;
		touch(note.view.contentDOM, "pointerup", 41, 100, 160, 0);
		const touchActionAfterHeldLift = note.view.scrollDOM.style.touchAction;

		const down = touch(note.view.contentDOM, "pointerdown", 42, 90, 170, 1);
		touch(note.view.contentDOM, "pointermove", 42, 145, 205, 1);
		touch(note.view.contentDOM, "pointerup", 42, 145, 205, 0);
		await settle();
		const storeAfterDraw = inlineInk.strokes(PATH_REENTRY).length;

		// Direct command entry reaches setInlineTool without going through the
		// strip. Start from a completed Keyboard scroll so its window is open.
		pressToolbarButton(keyboard);
		touch(note.view.contentDOM, "pointerdown", 43, 100, 240, 1);
		touch(note.view.contentDOM, "pointermove", 43, 100, 160, 1);
		touch(note.view.contentDOM, "pointerup", 43, 100, 160, 0);
		const touchActionAfterCompletedScroll = note.view.scrollDOM.style.touchAction;
		note.info.app.commands.executeCommandById("handwriting:inline-tool-pen");
		const touchActionAfterCommand = note.view.scrollDOM.style.touchAction;

		// A lit nib does not execute its command; its touch branch opens the
		// slider. It still represents renewed intent to draw and must reach the
		// same preparation seam.
		const router = (overlay as unknown as {
			router: { prepareFingerInk(): void };
		}).router;
		const prepare = router.prepareFingerInk.bind(router);
		let litReselectPrepareCalls = 0;
		router.prepareFingerInk = () => {
			litReselectPrepareCalls++;
			prepare();
		};
		pressToolbarButton(pen);
		delete (router as unknown as { prepareFingerInk?: () => void }).prepareFingerInk;

		// Pointer cancellation is not the native touch's end. Preparation stays
		// pending until touchcancel retires that separate ledger entry.
		pressToolbarButton(keyboard);
		nativeTouch(note.view.contentDOM, "touchstart", 444);
		touch(note.view.contentDOM, "pointerdown", 44, 100, 240, 1);
		touch(note.view.contentDOM, "pointermove", 44, 100, 160, 1);
		pressToolbarButton(pen);
		touch(note.view.contentDOM, "pointercancel", 44, 100, 160, 0);
		const touchActionAfterPointerCancel = note.view.scrollDOM.style.touchAction;
		nativeTouch(note.view.contentDOM, "touchcancel", 444);
		const touchActionAfterNativeCancel = note.view.scrollDOM.style.touchAction;

		// Highlighter has different real command ordering from Pen: its command
		// selects the nib while input is still off, then the strip enables input.
		// Preparation therefore has to retry after setPenInk(true).
		pressToolbarButton(keyboard);
		touch(note.view.contentDOM, "pointerdown", 45, 100, 240, 1);
		touch(note.view.contentDOM, "pointermove", 45, 100, 160, 1);
		touch(note.view.contentDOM, "pointerup", 45, 100, 160, 0);
		const touchActionAfterHighlighterScroll = note.view.scrollDOM.style.touchAction;
		const highlighter = toolbarButton(note.wrapper, "Highlighter");
		if (!highlighter) throw new Error("missing Highlighter control");
		pressToolbarButton(highlighter);
		const touchActionAfterHighlighter = note.view.scrollDOM.style.touchAction;
		const toolAfterHighlighter = getInlineTool();

		return {
			mounted: true,
			touchActionAfterPenWhileHeld,
			touchActionAfterHeldLift,
			touchActionAfterCompletedScroll,
			touchActionAfterCommand,
			litReselectPrepareCalls,
			touchActionAfterPointerCancel,
			touchActionAfterNativeCancel,
			touchActionAfterHighlighterScroll,
			touchActionAfterHighlighter,
			penCommandCount: note.executedCommands.filter(
				(id) => id === "handwriting:inline-tool-pen"
			).length,
			highlighterCommandCount: note.executedCommands.filter(
				(id) => id === "handwriting:inline-tool-highlighter"
			).length,
			penInkAfterPen: penInkEnabled(),
			toolPickedAfterPen: toolPickedHere(),
			toolAfterHighlighter,
			downPrevented: down.defaultPrevented,
			storeAfterDraw,
		};
	} finally {
		note.view.destroy();
		note.wrapper.remove();
		inlineInk.handleDelete(PATH_REENTRY);
	}
}

async function run(): Promise<FingerLifecycleTrace> {
	resetSession();
	try {
		return {
			route: await routeTrace(),
			teardown: await teardownTrace(),
			keyboard: await keyboardTrace(),
			reentry: await reentryTrace(),
		};
	} finally {
		for (const path of ALL_PATHS) inlineInk.handleDelete(path);
		clearGatedCommandActions();
		resetPenInkForTest();
		setMouseInk(false);
		clearToolPicked();
		resetPenToolsForTest();
	}
}

(window as unknown as Window & { inlineFingerLifecycle: { run: typeof run } }).inlineFingerLifecycle = {
	run,
};
