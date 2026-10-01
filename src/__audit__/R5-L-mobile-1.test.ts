/**
 * Audit probe R5-L-mobile-1 (1.4.21, tag 1a05f62c). Read-only verification.
 *
 * Claim: a finger drag on the strip's pill, its grip or a size slider is also
 * taken by Obsidian mobile's swipe recogniser (sidebar drawer / pull-down
 * command palette), because the strip handles drags with pointer events only
 * and gives Obsidian nothing that makes it stand down.
 *
 * Obsidian 1.13.7's recogniser (app.js @722629 `dg`) is a bubble-phase
 * touchstart listener on workspace.containerEl. Its only exits on touchstart
 * are: the event never reaching the container (propagation stopped below
 * it), an ancestor of the target with `dataset.ignoreSwipe`, an audio
 * ancestor, a stylus touchType, or a canvas under the point. Obsidian's own
 * range slider sets `dataset.ignoreSwipe = "true"` (@1123690). This probe
 * builds the REAL MobileTools inside a pane that sits in a workspace
 * container (the shape InkOverlay.chromeHost() gives it: view.dom's parent),
 * finds the real handles, confirms they are live drag handles, then walks a
 * finger touchstart/touchmove up the real element tree through whatever
 * listeners the production code registered, and asks the recogniser's two
 * DOM-level exits. The CORRECT behaviour asserted: the recogniser must not
 * arm for a drag that starts on the strip. Red = the bug is real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MobileTools, type MobileToolsHost } from "../inline/MobileTools";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { penInkEnabled, resetPenInkForTest } from "../inline/PenInk";
import { clearToolPicked } from "../inline/MouseInk";

const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	setPlacement: () => {},
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(),
	// A phone: touch present.
	hasTouch: () => true,
	...over,
});

/** The Obsidian mobile tree the strip is mounted in (InkOverlay.ts:2845, :3788-3799). */
function buildWorkspace() {
	const doc = new FakeDoc();
	const workspace = new FakeEl("div", doc, { cls: "workspace" }); // dg(workspace.containerEl)
	const rootSplit = workspace.createDiv({ cls: "workspace-split mod-root" });
	const leafContent = rootSplit.createDiv({ cls: "workspace-leaf-content" });
	const viewContent = leafContent.createDiv({ cls: "view-content" });
	const pane = viewContent.createDiv({ cls: "markdown-source-view" }); // view.dom.parentElement
	const cmEditor = pane.createDiv({ cls: "cm-editor" }); // view.dom
	const scroller = cmEditor.createDiv({ cls: "cm-scroller" }); // router's scrollEl
	const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost());
	return { doc, workspace, rootSplit, pane, scroller, strip };
}

interface SwipeReadout {
	reachedWorkspace: boolean;
	ignoreSwipeOnPath: boolean;
	stopped: boolean;
}

/**
 * Dispatch a finger touch event at `target` and let it bubble up the real
 * element tree through every listener production code registered, stopping
 * where one stops it; then read Obsidian's DOM-level exits (@722944):
 * `for (r = targetNode; r; r = r.parentNode) if (r.dataset.ignoreSwipe) return`.
 */
function fingerTouch(type: string, target: FakeEl, workspace: FakeEl): SwipeReadout {
	let stopped = false;
	const touch = { identifier: 7, clientX: 300, clientY: 40, touchType: "direct" };
	const ev = {
		type,
		target,
		targetNode: target,
		touches: [touch],
		changedTouches: [touch],
		preventDefault: (): void => {},
		stopPropagation: (): void => {
			stopped = true;
		},
		stopImmediatePropagation: (): void => {
			stopped = true;
		},
	};
	let reachedWorkspace = false;
	for (let el: FakeEl | null = target; el; el = el.parentElement) {
		if (stopped) break;
		if (el === workspace) {
			reachedWorkspace = true;
			break;
		}
		el.dispatch(ev);
	}
	let ignoreSwipeOnPath = false;
	for (let el: FakeEl | null = target; el; el = el.parentElement) {
		if (el.dataset.ignoreSwipe) ignoreSwipeOnPath = true;
	}
	return { reachedWorkspace, ignoreSwipeOnPath, stopped };
}

const recogniserArms = (r: SwipeReadout): boolean => r.reachedWorkspace && !r.ignoreSwipeOnPath;

describe("R5-L-mobile-1: a finger drag on the strip must not arm Obsidian's swipe", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
	});
	afterEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
	});

	function handles() {
		const w = buildWorkspace();
		const pill = w.pane.querySelector(".handwriting-pen-pill");
		const grip = w.pane.querySelector(".handwriting-tools-grip");
		const sliders = w.pane.querySelectorAll(".handwriting-eraser-slider");
		return { ...w, pill, grip, sliders };
	}

	it("precondition: pill and grip are live drag handles, a range slider exists, all inside the workspace and outside the note scroller", () => {
		const { workspace, rootSplit, scroller, pill, grip, sliders } = handles();
		expect(pill, "pill built").not.toBeNull();
		expect(grip, "grip built").not.toBeNull();
		expect(sliders.length, "at least one size slider built").toBeGreaterThan(0);
		for (const s of sliders) expect(s.getAttribute("type")).toBe("range");
		for (const [name, h] of [
			["pill", pill!],
			["grip", grip!],
		] as const) {
			let prevented = 0;
			h.fire("pointerdown", {
				pointerType: "touch",
				pointerId: 7,
				button: 0,
				isPrimary: true,
				clientX: 300,
				clientY: 40,
				preventDefault: () => void prevented++,
			});
			// The real armDrag handler (MobileTools.ts:3281) ran: it took capture.
			expect(h.captured, `${name} armDrag took pointer capture`).toBe(7);
			// At least armDrag's own preventDefault (the pill has a second pointerdown listener too).
			expect(prevented, `${name} pointerdown preventDefault`).toBeGreaterThanOrEqual(1);
			h.fire("pointerup", { pointerId: 7 });
			w_endDrag(h);
		}
		for (const h of [pill!, grip!, ...sliders]) {
			// Obsidian's `e.contains(l)` and the pull action's rootSplit check hold.
			expect(workspace.contains(h)).toBe(true);
			expect(rootSplit.contains(h)).toBe(true);
			// InlinePenRouter.ts:1330 `if (!this.scrollEl.contains(target)) return;`
			// - the router's window-capture touch filter never sees these.
			expect(scroller.contains(h)).toBe(false);
		}
	});

	// Release the drag the precondition armed (document-level endDrag, MobileTools.ts:1561).
	function w_endDrag(h: FakeEl): void {
		h.ownerDocument.fire("pointerup", { pointerId: 7, clientX: 300, clientY: 40 });
	}

	for (const which of ["pill", "grip", "slider"] as const) {
		it(`a finger touchstart and touchmove on the ${which} leave Obsidian's swipe recogniser disarmed`, () => {
			const { workspace, pill, grip, sliders } = handles();
			const target = which === "pill" ? pill! : which === "grip" ? grip! : sliders[0]!;
			// Pointer events come first for the same contact, as on a device.
			target.fire("pointerdown", {
				pointerType: "touch",
				pointerId: 7,
				button: 0,
				isPrimary: true,
				clientX: 300,
				clientY: 40,
			});
			const start = fingerTouch("touchstart", target, workspace);
			const move = fingerTouch("touchmove", target, workspace);
			const detail = JSON.stringify({ start, move });
			expect(
				recogniserArms(start),
				`touchstart on the ${which} reaches workspace.containerEl with no ignoreSwipe on its path: ${detail}`
			).toBe(false);
		});
	}

	it("control: the harness does go green when a swipe exit is present", () => {
		const { workspace, pane, grip } = handles();
		// Plant 1: Obsidian's own mechanism, dataset.ignoreSwipe on an ancestor.
		pane.dataset.ignoreSwipe = "true";
		expect(recogniserArms(fingerTouch("touchstart", grip!, workspace))).toBe(false);
		delete pane.dataset.ignoreSwipe;
		// Plant 2: a touchstart listener below the container that stops propagation.
		grip!.addEventListener("touchstart", (ev) => (ev as { stopPropagation(): void }).stopPropagation());
		expect(recogniserArms(fingerTouch("touchstart", grip!, workspace))).toBe(false);
	});
});
