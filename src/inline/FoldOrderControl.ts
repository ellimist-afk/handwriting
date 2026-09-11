/**
 * The settings control for the toolbar's fold order.
 *
 * WHAT IT IS FOR. On a narrow pane the strip cannot show thirteen buttons, so
 * named ones move behind a "More" chevron in a fixed order (`StripOverflow.ts`).
 * That order became a setting on 2026-09-05 - alan: "maybe we can have a way
 * you can rearrange the symbols in the fold list, for some customization" -
 * and this is the control that sets it. The model landed first and on purpose:
 * `stripFoldOrder`, `normalizeFoldOrder` and `applyStripFoldOrder` all exist
 * already, so this file adds a way to SAY something the plugin already knows
 * how to hear, and adds no second store to disagree with the first.
 *
 * THE OWNER'S RULINGS, verbatim, because three of them removed things a
 * builder would otherwise reach for:
 *  - "i personally prefer drag handles, like most people.... i dont want
 *    both". So: drag handles, and NO up/down arrow buttons anywhere - not on
 *    hover, not on touch, not as a fallback. The keyboard path lives on the
 *    focused grip (ArrowUp/ArrowDown) and draws nothing; it is accessibility,
 *    not a second control.
 *  - "the first row of icons is not colored in ... is there another way?" So
 *    the six never-folding buttons are drawn at full strength, the two nibs
 *    wearing their real ink - never dimmed.
 *  - "a toolbar width is insane lol. can we autodetect so it doesnt have ugly
 *    presets?", and again on the third mock, "no slider presets is sick". So
 *    there is NO width slider and NO presets. The preview folds at the width
 *    the real strip has on this device right now.
 *  - "the preview is a fantastic idea, definitely keep that".
 *
 * AND TWO MORE, on the third mock (2026-09-05 18:06), both of which this file
 * is written against rather than tidied towards afterwards:
 *  - "get rid of the pin and the caption suxxxxxxxxxxxxxxx, why do you write
 *    like a bonehead". There is no pin glyph. The six fixed buttons are marked
 *    fixed by having no grip, and by nothing else at all. Every string in this
 *    file is short, plain, and says one thing once; no sentence explains the
 *    mechanism a second time and none of them hedge.
 *  - "it's too wide" / "it is the whole thing look to the right". The card and
 *    the preview box are capped at 600px and left-aligned under the setting
 *    name - nothing spans the settings column - and the list itself is 400px,
 *    which is as wide as its own content. Only the preview STRIP is the
 *    detected width, scaled down when that exceeds the box, because the strip's
 *    width is the measurement and must not be edited to fit a layout.
 *
 * AND TWO MORE, on the fourth and fifth mocks, which are why the line is
 * always drawn and why the word "fold" is not in this control anywhere a user
 * can read it:
 *  - "what happened to the purple line, it syas everything fits on this screen
 *    at the botttm, i read that to mean all 6 of those tools are going to
 *    appear on the fold"; "how are they going to tell which one is kept on the
 *    toolbar?". A line that disappeared whenever nothing moved took the only
 *    mark of WHERE THE SPLIT IS off the list, and left a caption underneath to
 *    be read as a statement about the whole list. So the line is drawn at every
 *    width - under the last row when everything fits - and it carries its own
 *    label, "More", saying what lives below it.
 *  - "can we improve wording o the caption? nothing folds on this screen isnt
 *    great... i dont even know what folding is as a noob". Nothing a user reads
 *    says "fold". The setting is called "Toolbar buttons", and every string
 *    names the button on the screen rather than the mechanism behind it. Nor
 *    does anything a user reads say "narrow": a screen is SMALL, which is the
 *    word people use about their own. The internal names - this file,
 *    `stripFoldOrder`, `normalizeFoldOrder` - keep theirs: they are the
 *    strip's vocabulary and no user meets them.
 *
 * WHY THE PREVIEW IS A REAL STRIP. It is a `MobileTools` in a container of the
 * detected width, built through the same constructor the editor uses, folding
 * through the same `layoutOverflow` and the same `overflowPlan`. Anything else
 * - a row of divs shaped like the strip, a second copy of the fold arithmetic -
 * is a drawing, and a drawing is free to be wrong in exactly the case nobody
 * checks. The strip is inert here (see `previewStripHost`) and knows it is a
 * preview only so that it cannot write the session's collapsed state; every
 * other line of it is the strip Alan will see over his note.
 */

import { setIcon } from "obsidian";
import { deviceHasTouch } from "./DeviceInput";
import {
	MobileTools,
	NEVER_FOLDING_FACES,
	normalizeFoldOrder,
	stripBuildsButton,
	stripButtonFace,
	type MobileToolsHost,
	type StripButtonFace,
} from "./MobileTools";
import { type InkPreset } from "../ink/InkPresets";
import { type ToolbarCorner } from "./ToolbarCorner";

/** One list row's height, and the gap under it: the step a drag counts in. */
const ROW_HEIGHT = 36;
const ROW_GAP = 4;
const ROW_STEP = ROW_HEIGHT + ROW_GAP;

/**
 * The list the user reads, from the order the strip folds in.
 *
 * TWO DIRECTIONS, ONE REVERSAL, and both are named because every defect this
 * pair exists to prevent is somebody reversing it an odd number of times. The
 * SETTING is a fold order: `stripFoldOrder[0]` is the first button to leave the
 * row. The CONTROL is a priority list, read top-down as "keep this one
 * longest". They are the same array backwards, and a list that reads correctly
 * while folding from the wrong end looks perfectly right until the pane gets
 * narrow - which is the one moment anybody would be looking.
 */
export function priorityFromFoldOrder(order: readonly string[]): string[] {
	return [...order].reverse();
}

/** The order to save, from the list the user has just dragged. */
export function foldOrderFromPriority(priority: readonly string[]): string[] {
	return [...priority].reverse();
}

/**
 * The caption under the list, in words.
 *
 * PURE, so the wording can be pinned by a test that reads it rather than by a
 * test that renders it at a width the suite has no way to produce. Alan
 * rejected the previous sentence for naming the mechanism - "i dont even know
 * what folding is as a noob" - so what this says is where the buttons ARE, in
 * terms of the button he can see.
 */
export function moreCaption(behind: number): string {
	if (behind === 0) return "Drag to order. Everything fits on the screen.";
	return "Drag to order. Buttons below this line will collapse when window narrows.";
}

/** What one row's position means, for the screen reader that cannot see it. */
export function rowFate(isBehind: boolean): string {
	return isBehind ? "behind More on this screen" : "stays on the first row";
}

/**
 * How wide the strip's own parent is on this device, right now.
 *
 * NOT A MODEL OF THE ANSWER. `layoutOverflow` measures `parent.clientWidth`,
 * where `parent` is whatever the surface handed the strip - and on a note that
 * is `chromeHost()`, `view.dom.parentElement`, with `view.dom` being
 * CodeMirror's `.cm-editor`. So the first two branches below read the very
 * element the fold is computed against, one step earlier in the same walk.
 *
 * The cascade, most honest first:
 *  1. A strip that is actually on screen. Its parent IS the measured element,
 *     so there is nothing left to infer.
 *  2. The active editor's pane, for the common case where the settings tab is
 *     open over a note whose pen toolbar is not up (auto mode, no pen yet).
 *  3. The centre of the workspace - the window less the side panes, MEASURED
 *     rather than arrived at by subtracting guesses at their widths.
 *  4. The window. A settings tab open with no workspace at all is not a state
 *     anyone can reach, but a number is owed and this one is never absurd.
 */
export function detectStripWidth(doc: Document, win: Window | null): number {
	// ALL of them, not the first, and NOTHING INSIDE THIS CONTROL.
	//
	// The control puts the strip's own class on two of its own elements - the
	// preview's strip, and the bar of always-shown buttons, which wears
	// `.handwriting-mobile-tools` precisely so the stylesheet paints it exactly
	// as the toolbar is painted. Either would make this measure the settings
	// pane and call it the note's width, and the second one is worse than the
	// first because it is always present: with no real strip on screen - pen
	// toolbar set to Hide, or auto before the first pen contact, which is
	// exactly when somebody opens this control - the detected width would be
	// the card's inner width, ~568px, and the preview would show a fold that
	// the real toolbar does not have. So the skip is the whole control, by its
	// root class, rather than the preview pane alone.
	//
	// A `querySelector` would also have been wrong: the settings modal is a
	// sibling of the workspace, not a child, so one of ours can sit EARLIER in
	// document order than the editor's and the first match is not the real one.
	for (const strip of Array.from(doc.querySelectorAll(".handwriting-mobile-tools"))) {
		if (strip.closest(".handwriting-fold-order")) continue;
		const pane = strip.parentElement;
		if (pane && pane.clientWidth > 0) return pane.clientWidth;
	}
	const editor =
		doc.querySelector(".workspace-leaf.mod-active .cm-editor") ?? doc.querySelector(".cm-editor");
	const editorPane = editor?.parentElement ?? null;
	if (editorPane && editorPane.clientWidth > 0) return editorPane.clientWidth;
	const root = doc.querySelector(".workspace-split.mod-root");
	if (root && root.clientWidth > 0) return root.clientWidth;
	return win?.innerWidth ?? 0;
}

/** The live reads a preview strip is allowed to make of the real plugin. */
export interface PreviewStripReads {
	/** One nib's current ink, so the preview wears the colours the strip wears. */
	toolColor(tool: string): string;
	/** That nib's palette, so the tinted icon's tooltip can name its colour. */
	paletteFor(tool: string): ReadonlyArray<{ name: string; hex: string }>;
	/** Whether the bug-report dot is showing, because the dot costs row width. */
	recordingOn(): boolean;
}

/**
 * The host a PREVIEW strip is built with: every read honest, every action a
 * no-op.
 *
 * INERT BY CONSTRUCTION, not by CSS alone. The stylesheet also refuses pointer
 * events on everything but the More chevron, but a settings tab that could
 * change the active tool by being looked at would be a defect whichever layer
 * failed - so the host cannot do it either. `exec` runs nothing, the two mouse
 * ink calls do nothing, and the eraser and size setters do nothing.
 *
 * THE ENABLED READS ARE TRUE ON PURPOSE. Delete, Copy, Paste, Undo and Redo dim
 * when they would no-op, and a preview drawn with them all dimmed would say
 * something false about the strip - the preview's question is WHICH BUTTONS SIT
 * WHERE, and a dimmed button is still there. So the preview is drawn as a strip
 * with everything available.
 *
 * `recordingOn` is the one state read that changes the FOLD rather than the
 * look: the recording dot is on the row and takes width from the budget, so a
 * preview that ignored it would fold one button late for anyone running a bug
 * report. It comes through from the plugin for that reason alone.
 */
export function previewStripHost(reads: PreviewStripReads): MobileToolsHost {
	return {
		exec: () => {},
		// A DROP IN THE PREVIEW MOVES NOTHING. The preview strip is a picture
		// of the real one at the detected width; its grip can be dragged like
		// any other, and a placement written from inside a settings row would
		// move every real toolbar in the window - the same class of reach the
		// preview's Collapse button already had taken away from it.
		setPlacement: () => {},
		activeTool: () => "pen",
		eraserOn: () => false,
		eraserWholeStroke: () => false,
		setEraserWholeStroke: () => {},
		lassoOn: () => false,
		spaceOn: () => false,
		panOn: () => false,
		toolColor: (tool) => reads.toolColor(tool),
		eraserRadiusPx: () => 10,
		setEraserRadiusPx: () => {},
		inkSizeMult: () => 1,
		setInkSizeMult: () => {},
		canUndo: () => true,
		canRedo: () => true,
		canPasteInk: () => true,
		mouseInkOn: () => false,
		armMouseInkQuietly: () => {},
		disarmMouseInkQuietly: () => {},
		toast: () => {},
		recordingOn: () => reads.recordingOn(),
		hasInkSelection: () => true,
		paletteFor: (tool) => reads.paletteFor(tool),
		pickColor: () => {},
		presetsFor: (): readonly InkPreset[] => [],
		applyPreset: () => {},
		starPreset: () => {},
		forgetPreset: () => {},
		setEditorFocus: () => {},
		// Pen input ON, so the Keyboard button reads unlit - the state a strip
		// is in almost all of the time. Whether the button EXISTS is not asked
		// here: `shownOn` reads the device's own pen latch, so the preview grows
		// a Keyboard button exactly where the real strip has one.
		penInksHere: () => true,
		hasTouch: () => deviceHasTouch(),
	};
}

/** What the control needs from the plugin, and nothing more. */
export interface FoldOrderControlOptions {
	/**
	 * The saved fold order. Read FRESH on every sync rather than captured: the
	 * setting can move under an open settings tab (a sync landing, a second
	 * window), and the list must be able to catch up.
	 */
	order(): readonly string[];
	/**
	 * The ONE writer: `HandwritingPlugin.applyStripFoldOrder`, which normalises,
	 * saves, and re-folds every strip on screen. The control never assigns the
	 * setting itself and never keeps a second copy it believes over this one.
	 */
	apply(order: readonly string[]): void;
	/** Which corner the strip parks in, so the preview parks in the same one. */
	corner(): ToolbarCorner;
	/** The host the preview strip is built with; see `previewStripHost`. */
	previewHost: MobileToolsHost;
}

interface DragState {
	id: string;
	from: number;
	to: number;
	y0: number;
	pointerId: number;
	row: HTMLElement;
	grip: HTMLElement;
}

export class FoldOrderControl {
	private readonly root: HTMLElement;
	private readonly list: HTMLElement;
	private readonly foldCap: HTMLElement;
	private readonly resetBtn: HTMLButtonElement;
	private readonly live: HTMLElement;
	private readonly widthLabel: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly previewPane: HTMLElement;
	private previewScale = 1;
	private readonly rows = new Map<string, HTMLElement>();

	/** The list as it reads, top-down. Always a mirror of the saved setting. */
	private priority: string[] = [];
	private strip: MobileTools | null = null;
	private drag: DragState | null = null;
	private width = 0;
	/** Guards the measure pass against re-entering itself; see `measure`. */
	private measuring = false;
	private resizeWatch: { disconnect(): void } | null = null;
	private readonly win: Window | null;

	constructor(
		parent: HTMLElement,
		private readonly opts: FoldOrderControlOptions
	) {
		// NAMED AFTER THE SETTING ROW, and grouped so the name is spoken at all:
		// an `aria-label` on a bare div is dropped, so the role goes with it.
		// The section is two cards and a live region, none of which says on its
		// own what the whole thing is; the setting's name does.
		this.root = parent.createDiv({
			cls: "handwriting-fold-order",
			attr: { role: "group", "aria-label": "Toolbar buttons" },
		});
		this.win = this.root.ownerDocument.defaultView;
		const card = this.root.createDiv({ cls: "handwriting-fold-card" });

		// ---- the six that never move -------------------------------------
		card.createDiv({ cls: "handwriting-fold-head", text: "Always shown" });
		const fixedRow = card.createDiv({ cls: "handwriting-fold-fixed-row" });
		// The strip's OWN class on the bar and the strip's own class on each
		// button, so these are painted by the same rules the toolbar is painted
		// by - the size, the radius, the icon sizing and the theme's colours all
		// arrive without being restated. What the stylesheet undoes for this one
		// copy is only what makes a strip a strip: the absolute positioning, the
		// shadow and the 0.92 opacity.
		const bar = fixedRow.createDiv({
			cls: "handwriting-mobile-tools handwriting-fold-fixed-bar",
			attr: {
				// Named from the faces rather than typed out, so a build that
				// changed which buttons stay cannot leave this reading the old six.
				"aria-label": `Always shown: ${NEVER_FOLDING_FACES.map((f) => f.label).join(", ")}`,
			},
		});
		for (const face of NEVER_FOLDING_FACES) {
			const btn = bar.createDiv({ cls: "handwriting-mobile-tool handwriting-fold-fixed-btn" });
			this.paintIcon(btn, face);
			// The two nibs wear their real ink here exactly as they do on the
			// strip. This is the whole of "the first row of icons is not colored
			// in": the answer is that they ARE coloured, in the colours they are
			// actually holding, not tinted to look enabled.
			if (face.inkTool !== undefined) {
				btn.setCssStyles({ color: this.opts.previewHost.toolColor(face.inkTool) });
			}
		}
		// ---- the list ----------------------------------------------------
		card.createDiv({ cls: "handwriting-fold-head", text: "Keep on the toolbar" });
		// NO SENTENCE ABOUT DIRECTION. Alan, on the sixth mock: "the caption,
		// top stays out longest, bottom goes behind more first is like ooga
		// booga talk that's insulting. just make it obvious from the design."
		// What says it instead: the numbered rows, the dashed line with its
		// "More" label sitting between the two halves, the caption under it,
		// and the preview re-folding while a row is dragged.
		this.list = card.createDiv({
			cls: "handwriting-fold-list",
			attr: { role: "list", "aria-label": "Keep on the toolbar" },
		});
		// ALWAYS DRAWN, at every width. Alan, on the fourth mock: "what
		// happened to the purple line, it syas everything fits on this screen
		// at the botttm, i read that to mean all 6 of those tools are going to
		// appear" - a line that vanished when nothing moved left the list with
		// no mark at all, and the caption underneath was read as describing the
		// whole list. When nothing goes behind More it sits UNDER the last row,
		// which says the same thing the line always says: everything above me
		// stays. Its label comes from the stylesheet (`::after`, "More"), so
		// there is no text node here for a drag to have to step over.
		//
		// Positioned from a custom property rather than inserted between two
		// rows: a line that was a SIBLING of the rows would have to be moved
		// every time the split moved, and a drag would have to skip it.
		this.list.createDiv({ cls: "handwriting-fold-line", attr: { "aria-hidden": "true" } });
		this.foldCap = card.createDiv({ cls: "handwriting-fold-cap" });

		const foot = card.createDiv({ cls: "handwriting-fold-foot" });
		this.resetBtn = foot.createEl("button", {
			cls: "handwriting-fold-reset",
			text: "Reset to default",
			attr: { type: "button" },
		});
		this.resetBtn.addEventListener("click", () => this.reset());

		// ---- the preview -------------------------------------------------
		const preview = this.root.createDiv({ cls: "handwriting-fold-preview" });
		const head = preview.createDiv({ cls: "handwriting-fold-preview-head" });
		const title = head.createSpan({ cls: "handwriting-fold-preview-title", text: "Preview" });
		title.createSpan({ cls: "handwriting-fold-preview-live", text: "Live" });
		this.widthLabel = head.createSpan({ cls: "handwriting-fold-preview-width" });
		this.stage = preview.createDiv({ cls: "handwriting-fold-preview-stage" });
		this.previewPane = this.stage.createDiv({ cls: "handwriting-fold-preview-pane" });

		// Its own class beside the shared one: the preview is a real strip and
		// brings its own `.handwriting-sr-only` spans, so "the live region" has
		// to be nameable without picking whichever came first in the tree.
		this.live = this.root.createSpan({
			cls: "handwriting-sr-only handwriting-fold-live",
			attr: { role: "status", "aria-live": "polite" },
		});

		this.buildRows();
		this.buildPreview();
		this.syncFromSetting();
		this.watchWidth();
	}

	/** The strip's own icon call, with the strip's own glyph fallback. */
	private paintIcon(el: HTMLElement, face: StripButtonFace): void {
		setIcon(el, face.icon);
		if (!el.querySelector("svg")) el.setText(face.glyph);
	}

	/**
	 * One row per button that can move AND EXISTS ON THIS DEVICE.
	 *
	 * The second half is load-bearing, not tidiness. `Keyboard` is in the fold
	 * order on every device and is only BUILT where a pen has been seen
	 * (`ButtonSpec.shownOn`), and `overflowPlan` skips an id it cannot find and
	 * carries on demoting. So a list that showed all six on a mouse-only
	 * machine would (a) offer a row for a button that is not on the toolbar and
	 * (b) be one row out of step with the strip: with three buttons behind
	 * More, the line would sit a row too low and two rows would be labelled
	 * with the wrong fate. Filtering here restores the invariant the fold line
	 * rests on - what moves is always the TAIL of this list - because the ids
	 * left are exactly the ids `overflowPlan` can demote, in the same order.
	 *
	 * Created ONCE and thereafter only reordered: re-creating them per change
	 * would replace the grip under a dragging finger and drop the focus of the
	 * row being moved by keyboard.
	 */
	private buildRows(): void {
		for (const id of priorityFromFoldOrder(normalizeFoldOrder(this.opts.order()))) {
			if (!stripBuildsButton(id, this.opts.previewHost)) continue;
			const face = stripButtonFace(id);
			if (!face) continue;
			this.rows.set(id, this.makeRow(face));
		}
	}

	private makeRow(face: StripButtonFace): HTMLElement {
		const row = this.list.createDiv({ cls: "handwriting-fold-row", attr: { role: "listitem" } });
		row.dataset.commandId = face.commandId;
		row.createSpan({ cls: "handwriting-fold-index", attr: { "aria-hidden": "true" } });
		const grip = row.createEl("button", {
			cls: "handwriting-fold-grip",
			attr: { type: "button", "aria-label": `Reorder ${face.label}` },
		});
		setIcon(grip, "grip-vertical");
		if (!grip.querySelector("svg")) grip.setText("::");
		const icon = row.createSpan({
			cls: "handwriting-fold-icon",
			attr: { "aria-hidden": "true" },
		});
		this.paintIcon(icon, face);
		// `title` as well as the text: the label is the strip's own, which for
		// the Keyboard button is a sentence, and a name that ellipsises in a
		// narrow settings pane must still be readable somehow.
		row.createSpan({
			cls: "handwriting-fold-name",
			text: face.label,
			attr: { title: face.label },
		});
		row.addEventListener("pointerdown", (ev: PointerEvent) => this.startDrag(ev, row, grip));
		grip.addEventListener("keydown", (ev: KeyboardEvent) => this.gripKey(ev, face.commandId));
		return row;
	}

	/**
	 * The preview strip, built once into a pane this control resizes.
	 *
	 * It goes into `liveStrips` like any other strip, which is what makes the
	 * preview re-fold the instant the order changes: `applyStripFoldOrder` ->
	 * `setStripFoldOrder` -> every live strip's `applyFoldOrder()`, this one
	 * among them. There is no second path from the list to the preview, so the
	 * two cannot get out of step.
	 */
	private buildPreview(): void {
		this.strip = new MobileTools(this.previewPane, this.opts.previewHost, { preview: true });
		this.strip.setCorner(this.opts.corner());
		this.sealPreview();
	}

	/**
	 * Take the preview out of the keyboard's reach, and out of the screen
	 * reader's.
	 *
	 * THE STYLESHEET IS NOT ENOUGH. `pointer-events: none` stops a mouse and a
	 * finger and does nothing about Tab: the preview is a real strip of real
	 * buttons, so without this a keyboard user tabbing through the settings
	 * pane walks into sixteen controls that look live and do nothing - and one
	 * that does something. Enter on its Collapse button reaches
	 * `MobileTools.setCollapsed`, whose first line assigns `collapsedSession`,
	 * and every real strip in the window collapses to its pill. That is the
	 * blast radius `MobileToolsOptions.preview` closes for the CONSTRUCTOR; the
	 * button is the other door into the same global, and this is what shuts it.
	 *
	 * `aria-hidden` goes with the tabindex rather than instead of it: hiding a
	 * subtree that still holds tab stops is its own defect, and the caption
	 * under the list is what actually tells a screen reader what the preview
	 * shows.
	 *
	 * Re-run after every re-fold. Folding re-parents the same button elements
	 * rather than making new ones, so one pass would do today; a pass that
	 * costs sixteen attribute writes on a settings tab is not worth being
	 * clever about, and the next thing this class draws might be new.
	 */
	private sealPreview(): void {
		this.previewPane.setAttribute("aria-hidden", "true");
		for (const el of Array.from(this.previewPane.querySelectorAll("button, input"))) {
			el.setAttribute("tabindex", "-1");
		}
	}

	// ---- reading and writing the setting ---------------------------------

	/**
	 * Re-read the setting and make the list say it.
	 *
	 * EVERY change lands here, including this control's own: a drag calls
	 * `apply` and then reads back what was saved rather than believing what it
	 * asked for. `normalizeFoldOrder` can and does change an order on its way
	 * in, so believing the request would let the list and the strip drift apart
	 * for exactly the inputs the normaliser exists to correct.
	 */
	private syncFromSetting(): void {
		const saved = normalizeFoldOrder(this.opts.order());
		this.priority = priorityFromFoldOrder(saved).filter((id) => this.rows.has(id));
		for (const id of this.priority) {
			const row = this.rows.get(id);
			if (row) this.list.appendChild(row);
		}
		// Hidden, not disabled: a colour-only disabled state is invisible on
		// e-ink, so a default order must make the button absent, not grey.
		this.resetBtn.hidden = this.isDefault();
		this.refold();
	}

	private isDefault(): boolean {
		const saved = normalizeFoldOrder(this.opts.order());
		const fresh = normalizeFoldOrder([]);
		return saved.length === fresh.length && saved.every((id, i) => id === fresh[i]);
	}

	/**
	 * Write a new priority list, then re-read it. The only writer in the file.
	 */
	private commit(next: readonly string[]): void {
		this.opts.apply(foldOrderFromPriority(next));
		this.syncFromSetting();
	}

	private reset(): void {
		if (this.isDefault()) return;
		// The empty array IS the default: `normalizeFoldOrder` appends every
		// missing id in `DEFAULT_FOLD_ORDER`'s own order, so nothing here has to
		// restate that order and nothing here can restate it wrongly. Through
		// `commit` rather than straight to `apply` so that this file keeps
		// exactly one line that writes the setting - reversing an empty list is
		// an empty list, so the two paths are the same call.
		this.commit([]);
		this.say("Order reset to default.");
	}

	/** Move one row by one place, from the keyboard. */
	private move(id: string, dir: -1 | 1): boolean {
		const from = this.priority.indexOf(id);
		const to = from + dir;
		if (from < 0 || to < 0 || to >= this.priority.length) return false;
		const next = [...this.priority];
		next.splice(from, 1);
		next.splice(to, 0, id);
		this.commit(next);
		this.announce(id, to);
		return true;
	}

	private gripKey(ev: KeyboardEvent, id: string): void {
		const dir = ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0;
		if (dir === 0) return;
		ev.preventDefault();
		if (!this.move(id, dir)) return;
		// The row moved and took its grip with it; focus follows the button the
		// user is still holding, or the next press goes nowhere.
		const grip = this.rows.get(id)?.querySelector(".handwriting-fold-grip");
		(grip as HTMLElement | null)?.focus();
	}

	// ---- the drag ---------------------------------------------------------

	private startDrag(ev: PointerEvent, row: HTMLElement, grip: HTMLElement): void {
		// A second pointer during a drag, and the right mouse button, are both
		// "not this gesture" rather than a second gesture.
		if (this.drag || (ev.button !== undefined && ev.button !== 0)) return;
		const id = row.dataset.commandId;
		if (id === undefined) return;
		const from = this.priority.indexOf(id);
		if (from < 0) return;
		// Without this a touch drag scrolls the settings pane instead, and a
		// mouse drag selects the row's text. `touch-action: none` in the
		// stylesheet covers the row; space outside the rows still scrolls.
		ev.preventDefault();
		// `preventDefault` above is what stops the grip taking focus, so the
		// two reorder paths did not compose: drag a row with the mouse, press
		// ArrowUp, and nothing happened because nothing was focused. Asked for
		// explicitly rather than by letting the default through, because the
		// default also starts a text selection across the list.
		grip.focus();
		try {
			grip.setPointerCapture(ev.pointerId);
		} catch {
			// A capture the engine refuses is survivable: the document
			// listeners below are what actually follow the pointer, and they do
			// not need it. Swallowed rather than logged - it is not an error
			// worth a line in anybody's console on every drag.
		}
		this.drag = { id, from, to: from, y0: ev.clientY, pointerId: ev.pointerId, row, grip };
		row.addClass("is-dragging");
		this.list.addClass("is-dragging");
		const doc = this.root.ownerDocument;
		doc.addEventListener("pointermove", this.onDragMove);
		doc.addEventListener("pointerup", this.onDragEnd);
		doc.addEventListener("pointercancel", this.onDragEnd);
		doc.addEventListener("keydown", this.onDragKey, true);
	}

	private readonly onDragMove = (ev: PointerEvent): void => {
		const d = this.drag;
		if (!d || ev.pointerId !== d.pointerId) return;
		const dy = ev.clientY - d.y0;
		const last = this.priority.length - 1;
		let to = d.from + Math.round(dy / ROW_STEP);
		if (to < 0) to = 0;
		if (to > last) to = last;
		d.to = to;
		d.row.setCssStyles({ transform: `translateY(${dy}px)` });
		// The siblings open the gap the dragged row will land in. Whole-step
		// shifts rather than following the finger: the row being dragged is the
		// one that tracks the pointer, and the rest of the list moving smoothly
		// with it makes it impossible to see where the drop actually is.
		this.priority.forEach((id, i) => {
			const el = this.rows.get(id);
			if (!el || el === d.row) return;
			let shift = 0;
			if (d.from < to && i > d.from && i <= to) shift = -ROW_STEP;
			else if (d.from > to && i >= to && i < d.from) shift = ROW_STEP;
			el.setCssStyles({ transform: shift === 0 ? "" : `translateY(${shift}px)` });
		});
	};

	private readonly onDragEnd = (ev: PointerEvent): void => {
		const d = this.drag;
		if (!d || ev.pointerId !== d.pointerId) return;
		this.endDrag(ev.type === "pointercancel" ? d.from : d.to);
	};

	/**
	 * Escape puts the row back where it started and stops there.
	 *
	 * Captured and stopped, which is the one place this control is allowed to
	 * take a key from the settings modal: the modal closes on Escape, and a
	 * half-finished drag being cancelled BY closing the whole settings window
	 * is not a cancel, it is a different accident. Only while a drag is live -
	 * `this.drag` is null the rest of the time and the listener is not even
	 * attached.
	 */
	private readonly onDragKey = (ev: KeyboardEvent): void => {
		if (ev.key !== "Escape" || !this.drag) return;
		ev.preventDefault();
		ev.stopPropagation();
		this.endDrag(this.drag.from);
	};

	private endDrag(to: number): void {
		const d = this.drag;
		if (!d) return;
		this.drag = null;
		this.stopDragListeners();
		try {
			d.grip.releasePointerCapture(d.pointerId);
		} catch {
			// See `startDrag`: a capture that was refused cannot be released.
		}
		for (const id of this.priority) this.rows.get(id)?.setCssStyles({ transform: "" });
		d.row.removeClass("is-dragging");
		this.list.removeClass("is-dragging");
		// A tap on the grip, and a cancelled drag, both arrive here with the row
		// at the index it started from. Writing the setting anyway would be a
		// save, a re-fold of every open strip and a data.json write for a
		// gesture that changed nothing.
		if (to === d.from) return;
		const next = [...this.priority];
		next.splice(d.from, 1);
		next.splice(to, 0, d.id);
		this.commit(next);
		this.announce(d.id, to);
	}

	private stopDragListeners(): void {
		const doc = this.root.ownerDocument;
		doc.removeEventListener("pointermove", this.onDragMove);
		doc.removeEventListener("pointerup", this.onDragEnd);
		doc.removeEventListener("pointercancel", this.onDragEnd);
		doc.removeEventListener("keydown", this.onDragKey, true);
	}

	// ---- the fold ---------------------------------------------------------

	/**
	 * Open the preview's second row whenever anything is behind More, closed
	 * when nothing is - re-evaluated on every re-fold rather than left at
	 * whatever a click last set, so the row never opens on a state nobody
	 * asked for and never stays open past the fold that made it relevant.
	 *
	 * `MobileTools` has no public setter for this: the chevron is the one
	 * live control the preview leaves clickable (see `sealPreview`), so that
	 * click is simulated here, and only when the state does not already
	 * match - not a second path onto the strip's own flag.
	 */
	private syncMoreOpen(open: boolean): void {
		const root = this.previewPane.querySelector(".handwriting-mobile-tools");
		const more = this.previewPane.querySelector(".handwriting-tools-more");
		if (!root || !more) return;
		if (root.classList.contains("is-more-open") !== open) {
			(more as HTMLElement).click();
		}
	}

	/**
	 * Where the fold falls, and what to say about it.
	 *
	 * The COUNT comes off the preview strip, which is the real strip: it has
	 * already run `overflowPlan` against its own measured button widths, and
	 * `foldedIds` is the plan it applied. Nothing here recomputes it. The rows
	 * that fold are the TAIL of the list by construction - `overflowPlan`
	 * demotes in fold order, which is this list read bottom-up - so a count is
	 * all the fold line needs.
	 */
	private refold(): void {
		const behind = new Set(this.strip?.foldedIds ?? []);
		// Counted by MEMBERSHIP rather than by subtracting a length. The two
		// agree whenever what moved is the tail of this list, which `buildRows`
		// is what guarantees; this way round the number is still the number of
		// rows that stay even if some id the strip moved is not a row here.
		const folded = this.priority.filter((id) => behind.has(id));
		const kept = this.priority.length - folded.length;
		this.list.style.setProperty("--handwriting-fold-keep", String(kept));
		this.list.toggleClass("is-nofold", folded.length === 0);
		this.foldCap.setText(moreCaption(folded.length));
		this.syncMoreOpen(folded.length > 0);
		this.sealPreview();
		this.fit();
		this.priority.forEach((id, i) => {
			const row = this.rows.get(id);
			if (!row) return;
			const index = row.querySelector(".handwriting-fold-index");
			if (index) index.textContent = String(i + 1);
			// ON THE GRIP, because the grip is what takes focus. A label on the
			// listitem is not what a screen reader reads out when the button
			// inside it is focused, so a keyboard user would have heard
			// "Reorder Pan" and nothing about where Pan sits or whether it
			// folds - which is the entire content of this list.
			const grip = row.querySelector(".handwriting-fold-grip");
			grip?.setAttribute(
				"aria-label",
				`Reorder ${stripButtonFace(id)?.label ?? id}, position ${i + 1} of ` +
					`${this.priority.length}, ` +
					rowFate(i >= kept) +
					// The only place the keyboard path is discoverable at all:
					// the visible hint came off with the third amendment, and a
					// grip announces itself as a button with no keys attached.
					". Drag, or press the up and down arrow keys."
			);
		});
	}

	private announce(id: string, at: number): void {
		const label = stripButtonFace(id)?.label ?? id;
		const folded = this.strip?.foldedIds.length ?? 0;
		const kept = this.priority.length - folded;
		this.say(
			`${label} moved to position ${at + 1} of ${this.priority.length}. ` +
				(at >= kept ? "Behind More on this screen." : "Stays on the first row.")
		);
	}

	private say(message: string): void {
		this.live.setText(message);
	}

	// ---- the detected width -----------------------------------------------

	/**
	 * Re-measure, resize the preview pane, and re-fold.
	 *
	 * RE-ENTRANT BY SHAPE: this writes the stage's height, the stage is inside
	 * the observed container, and a height change fires the observer again. What
	 * stops that is IDEMPOTENCE - the same inputs write the same height, and a
	 * write that changes nothing fires no observer - not the `measuring` latch,
	 * which a ResizeObserver's asynchronous callback can never be holding. The
	 * latch is for a synchronous second entry, which only a future caller can
	 * produce; it is cheap and it is not what makes this terminate.
	 */
	private measure(): void {
		if (this.measuring) return;
		this.measuring = true;
		try {
			const width = detectStripWidth(this.root.ownerDocument, this.win);
			if (width > 0 && width !== this.width) {
				this.width = width;
				this.previewPane.setCssStyles({ width: `${width}px` });
				this.widthLabel.setText(`Detected · ${width} px`);
				// The strip's own observer would get to this on the next frame;
				// `applyFoldOrder` does it now, so the fold line and the caption
				// below are never one resize behind what is on screen. Closing
				// the chevron is that method's own rule and the right one here:
				// the second row's contents have just changed.
				this.strip?.applyFoldOrder();
			}
			this.refold();
		} finally {
			this.measuring = false;
		}
	}

	/**
	 * Frame the toolbar itself, leaving empty detected-pane space out of the
	 * scale calculation so a wide editor does not make its preview tiny.
	 *
	 * The pane stays EXACTLY the detected width in layout - that is what the
	 * strip measures, and a strip measuring the settings pane's width would
	 * fold at the wrong place - and only its painting is scaled. A transform
	 * does not touch `offsetWidth`, which is what `layoutOverflow` reads, so
	 * this is invisible to the fold.
	 */
	private fit(): void {
		const room = this.stage.clientWidth;
		const strip = this.previewPane.querySelector<HTMLElement>(".handwriting-mobile-tools");
		if (!strip || room <= 0 || strip.offsetWidth <= 0) return;
		const padding = 8;
		const k = Math.min(1, room / (strip.offsetWidth + 2 * padding));
		// Include the strip's own corner transform (e.g. middle-center).
		const paneBox = this.previewPane.getBoundingClientRect();
		const stripBox = strip.getBoundingClientRect();
		const left = (stripBox.left - paneBox.left) / this.previewScale;
		const top = (stripBox.top - paneBox.top) / this.previewScale;
		const x = (room - strip.offsetWidth * k) / 2 - left * k;
		const y = (padding - top) * k;
		this.previewPane.setCssStyles({ transform: `translate(${x}px, ${y}px) scale(${k})` });
		this.previewScale = k;
		this.stage.setCssStyles({ height: `${Math.ceil((strip.offsetHeight + 2 * padding) * k)}px` });
	}

	private readonly onWindowResize = (): void => this.measure();

	private watchWidth(): void {
		this.measure();
		const Observer = (
			this.win as { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } } | null
		)?.ResizeObserver;
		// Guarded the way the strip's own observer is guarded, and for the same
		// reason: this class is constructed under a suite with no DOM, and a
		// control that throws in its constructor takes the settings tab down
		// with it.
		if (Observer) {
			try {
				const watch = new Observer(() => this.measure());
				watch.observe(this.root);
				this.resizeWatch = watch;
			} catch (err) {
				console.error("[handwriting] fold order observer failed", err);
			}
		}
		this.win?.addEventListener("resize", this.onWindowResize);
	}

	/**
	 * Give everything back: the settings tab has closed, or is re-rendering.
	 *
	 * The preview strip is the part that must not be forgotten. It is in
	 * `liveStrips` and holds five capturing document listeners, so a leaked one
	 * would be re-folded by every later `setStripFoldOrder` on behalf of a pane
	 * that no longer exists - the exact leak `MobileTools.destroy()` was written
	 * to prevent, arriving through a new door.
	 */
	destroy(): void {
		this.endDrag(this.drag?.from ?? 0);
		this.stopDragListeners();
		this.resizeWatch?.disconnect();
		this.resizeWatch = null;
		this.win?.removeEventListener("resize", this.onWindowResize);
		this.strip?.destroy();
		this.strip = null;
		this.rows.clear();
		this.root.remove();
	}
}
