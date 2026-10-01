import { getPenToolsMode, onPenToolsChanged, penSeenThisSession, penToolsVisible } from "../inline/PenToolsMode";
import { type App, Modal, Platform } from "obsidian";
import { MobileTools } from "../inline/MobileTools";
import { runGatedCommand } from "../CommandPaletteSplit";
import { colorsFor, getInkColorHex } from "../ink/InkColor";
import { type InkTool } from "../ink/Stroke";
import { applyInkPreset, forgetInkPreset, inkPresetsFor, starInkPreset } from "../ink/InkPresets";
import { deviceHasTouch } from "../inline/DeviceInput";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { mouseInkEnabled } from "../inline/MouseInk";
import {
	addStripSurface, applyToolbarPlacement, armMouseInkQuietlyEverywhere, releaseMouseInkQuietlyEverywhere,
	getInlineTool, getInlineEraserMode, getEraserWholeStrokes, setEraserWholeStrokes, persistEraserModeNow,
	getEraserRadiusPx, setEraserRadiusPx, commitEraserRadius, getInkSizeMult, setInkSizeMult, applyInkSize,
	pickStripColor, getToolbarCorner,
} from "../inline/InkOverlay";
import { slideActionAvailable, type SlidesAction, type SlidesActions } from "./SlidesActions";

export const SLIDES_COMMANDS = [
	{ id: "slides-undo", name: "Presentation: undo ink", action: "undo" },
	{ id: "slides-redo", name: "Presentation: redo ink", action: "redo" },
	{ id: "slides-clear-current", name: "Clear ink on this slide", action: "clear-current" },
	{ id: "slides-clear-all", name: "Clear all presentation ink", action: "clear-all" },
] as const;

export function requestSlidesAction(app: App, actions: SlidesActions, action: SlidesAction): void {
	if (action !== "clear-all") { actions.run(action); return; }
	actions.finishGesture();
	const status = actions.status();
	if (!slideActionAvailable(status, action)) return;
	class ClearPresentationModal extends Modal {
		onOpen(): void {
			this.contentEl.createEl("h2", { text: "Clear all presentation ink?" });
			this.contentEl.createEl("p", { text: `Remove ${status.totalCount} strokes from every slide, including retained ink on unmatched slides. You can undo this while the presentation stays open.` });
			const cancel = this.contentEl.createEl("button", { text: "Cancel" });
			cancel.addEventListener("click", () => this.close());
			const clear = this.contentEl.createEl("button", { text: "Clear all presentation ink" });
			clear.addEventListener("click", () => {
				const current = actions.status();
				if (current.revision === status.revision && !current.pendingGesture) actions.run(action);
				this.close();
			});
		}
		onClose(): void { this.contentEl.empty(); }
	}
	new ClearPresentationModal(app).open();
}

/** Registered callbacks capture no note view and resolve again on execution. */
export function presentationCommands(resolve: () => SlidesActions | null, execute: (actions: SlidesActions, action: SlidesAction) => void) {
	return SLIDES_COMMANDS.map(spec => ({ id: spec.id, name: spec.name, checkCallback: (checking: boolean): boolean => {
		const target = resolve();
		if (!target || !slideActionAvailable(target.status(), spec.action)) return false;
		if (!checking) execute(target, spec.action);
		return true;
	} }));
}

function buildSlidesTools(parent: HTMLElement, actions: SlidesActions, app: App, exec: (id: string) => void, toast: (text: string) => void): () => void {
	const root = parent.createDiv({ cls: "handwriting-slides-tools" });
	root.setCssStyles({ position: "absolute", inset: "0", pointerEvents: "none", zIndex: "40" });
	// Reveal blurs a deck when a pointerdown outside `.reveal` reaches its
	// document handler. Let the strip's own buttons handle the press, then stop
	// that bubble before it leaves the sibling toolbar.
	if (typeof root.addEventListener === "function") root.addEventListener("pointerdown", ev => ev.stopPropagation());
	const shared = new Set(["handwriting:inline-tool-pen", "handwriting:inline-tool-highlighter", "handwriting:inline-tool-eraser"]);
	const supportedCommands = new Set([...shared, "editor:undo", "editor:redo", "handwriting:slides-clear-current", "handwriting:slides-clear-all"]);
	const strip = new MobileTools(root, {
		exec: id => {
			if (!actions.status().live) return;
			if (id === "editor:undo" || id === "editor:redo") { actions.run(id === "editor:undo" ? "undo" : "redo"); return; }
			const command = SLIDES_COMMANDS.find(c => `handwriting:${c.id}` === id);
			if (command) { requestSlidesAction(app, actions, command.action); return; }
			if (shared.has(id)) { actions.finishGesture(); if (!runGatedCommand(id)) exec(id); }
			if (id === "handwriting:toggle-diagnostics") exec(id);
		},
		activeTool: getInlineTool, eraserOn: getInlineEraserMode,
		eraserWholeStroke: getEraserWholeStrokes,
		setEraserWholeStroke: on => { if (!actions.status().live) return; setEraserWholeStrokes(on); persistEraserModeNow(on); },
		lassoOn: () => false, spaceOn: () => false, panOn: () => false,
		toolColor: tool => getInkColorHex(tool as InkTool),
		eraserRadiusPx: getEraserRadiusPx,
		setEraserRadiusPx: (px, commit) => { if (!actions.status().live) return; setEraserRadiusPx(px); if (commit) commitEraserRadius(); },
		inkSizeMult: tool => getInkSizeMult(tool as InkTool),
		// A release (commit) is saved, as on the note's toolbar; the drag before it only shows.
		setInkSizeMult: (tool, mult, commit) => {
			if (!actions.status().live) return;
			if (commit) applyInkSize(tool as InkTool, mult);
			else setInkSizeMult(tool as InkTool, mult);
		},
		canUndo: () => slideActionAvailable(actions.status(), "undo"),
		canRedo: () => slideActionAvailable(actions.status(), "redo"),
		canPasteInk: () => false, hasInkSelection: () => false,
		mouseInkOn: mouseInkEnabled, armMouseInkQuietly: armMouseInkQuietlyEverywhere, disarmMouseInkQuietly: releaseMouseInkQuietlyEverywhere,
		toast, recordingOn: diagnosticsEnabled,
		paletteFor: tool => colorsFor(tool as InkTool),
		pickColor: (name, hex) => { if (actions.status().live) pickStripColor(name, hex); },
		presetsFor: tool => inkPresetsFor(tool as InkTool),
		applyPreset: (tool, index) => { if (actions.status().live) applyInkPreset(tool as InkTool, index); },
		starPreset: tool => { if (actions.status().live) starInkPreset(tool as InkTool); },
		forgetPreset: (tool, index) => { if (actions.status().live) forgetInkPreset(tool as InkTool, index); },
		setEditorFocus: () => {}, penInksHere: () => true, hasTouch: deviceHasTouch,
		setPlacement: applyToolbarPlacement,
	}, {
		supportedCommands,
		additionalButtons: [
			{ commandId: "handwriting:slides-clear-current", label: "Clear ink on this slide", icon: "eraser", glyph: "Cl", isEnabled: () => slideActionAvailable(actions.status(), "clear-current") },
			{ commandId: "handwriting:slides-clear-all", label: "Clear all presentation ink", icon: "trash-2", glyph: "All", isEnabled: () => slideActionAvailable(actions.status(), "clear-all") },
		],
	});
	for (const control of root.querySelectorAll<HTMLElement>(".handwriting-mobile-tools, .handwriting-pen-pill")) {
		control.setCssStyles({ pointerEvents: "auto" });
	}
	const status = root.createDiv({ attr: { role: "status" } });
	status.setCssStyles({ position: "absolute", bottom: "12px", left: "12px" });
	let corner = getToolbarCorner();
	strip.setCorner(corner);
	const refresh = () => {
		const nextCorner = getToolbarCorner();
		if (nextCorner !== corner) { corner = nextCorner; strip.setCorner(corner); }
		strip.refresh();
		const current = actions.status();
		status.textContent = [current.undoLabel && `Undo: ${current.undoLabel}`, current.redoLabel && `Redo: ${current.redoLabel}`].filter(Boolean).join(" · ") || "Presentation ink";
	};
	const off = actions.onChange(refresh);
	const offShared = addStripSurface(refresh, () => actions.finishGesture(), undefined, undefined, () => actions.finishGesture());
	refresh();
	return () => { off(); offShared(); strip.destroy(); root.remove(); };
}

/** Follow the shared auto/show/hide rule, including changes during a presentation. */
export function mountSlidesTools(parent: HTMLElement, actions: SlidesActions, app: App, exec: (id: string) => void, toast: (text: string) => void): () => void {
	let unmount: (() => void) | null = null;
	// The strip can be hidden while the presentation remains live. Keep its
	// render-only settings repaint registered for the whole deck lifetime.
	const offRepaint = addStripSurface(() => {}, undefined, () => actions.repaintSettings?.());
	const ensure = () => {
		const want = actions.status().live && penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession());
		if (want && !unmount) unmount = buildSlidesTools(parent, actions, app, exec, toast);
		else if (!want && unmount) { const remove = unmount; unmount = null; remove(); }
	};
	const offMode = onPenToolsChanged(ensure);
	const offDeck = actions.onChange(ensure);
	ensure();
	return () => { offMode(); offDeck(); offRepaint(); unmount?.(); unmount = null; };
}
