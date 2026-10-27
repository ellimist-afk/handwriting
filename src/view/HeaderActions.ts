/**
 * Header actions and canvas choice: the canvas and paper buttons in each note's view header, their refresh, and
 * the per-note Infinite Canvas choice written from the file menu or the command. The methods are methods of
 * HandwritingPlugin, installed on its prototype when main.ts loads (installHeaderActions at its bottom). Bodies
 * moved unchanged from the class. This file imports only types from main.
 */
import { apiVersion, getIcon, type MarkdownView, Notice, Platform } from "obsidian";
import { getToolbarCorner, inlineInk, setToolbarCorner } from "../inline/InkOverlay";
import { NotePaperPicker } from "../inline/NotePaper";
import { onInkChanged } from "../inline/InkEvents";
import { canvasForNote, type NoteCanvasChoice, onCanvasOverrideChanged } from "../inline/CanvasNoteOverride";
import { refreshNoteZoomControlsAll } from "../inline/MobileTools";
import { runDetached } from "../util/Detached";
import { blockNotice } from "./Notices";
import { installMethods } from "../inline/InstallMethods";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		refreshHeaderActions(): void;
		registerHeaderActions(): void;
		applyCanvasChoice(path: string, choice: NoteCanvasChoice): void;
	}
}

	function refreshHeaderActions(this: HandwritingPlugin): void {
		this.headerActionRefresh?.();
	}

	function registerHeaderActions(this: HandwritingPlugin): void {
		const actions = new Map<MarkdownView, { path: string; canvas: HTMLElement; paper: HTMLElement }>();
		const canvasIcon = getIcon("scan") !== null ? "scan" : "layout-grid";
		const paperIcon = getIcon("grid-3x-3") !== null
			? "grid-3x-3"
			: getIcon("grid-3x3") !== null ? "grid-3x3" : "layout-grid";
		const missingIcons = [
			...(canvasIcon === "layout-grid" ? ["scan"] : []),
			...(paperIcon === "layout-grid" ? ["paper grid"] : []),
		];
		if (missingIcons.length) console.warn(`Handwriting: ${missingIcons.join(", ")} unavailable in Obsidian ${apiVersion}; using layout-grid`);
		const loading = new Set<string>();
		const pickers = new Set<NotePaperPicker>();
		const remove = (view: MarkdownView): void => {
			const current = actions.get(view);
			if (!current) return;
			current.canvas.remove();
			current.paper.remove();
			actions.delete(view);
		};
		const refresh = (): void => {
			if (this.unloaded) return;
			let geometryChanged = false;
			const live = new Set<MarkdownView>();
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view as MarkdownView;
				live.add(view);
				const file = view.file;
				const path = file?.extension === "md" ? file.path : null;
				const presence = path ? inlineInk.inkPresence(path) : "none";
				const show = !Platform.isPhone && path !== null && presence === "ink";
				const current = actions.get(view);
				if (current && (!show || current.path !== path)) { remove(view); geometryChanged = true; }
				if (!show) {
					if (path && presence === "unknown" && !loading.has(path)) {
						loading.add(path);
						void inlineInk.ensureLoaded(path).then(refresh, () => {}).finally(() => loading.delete(path));
					}
					continue;
				}
				if (!actions.has(view)) {
					const canvas = view.addAction(canvasIcon, "Infinite canvas", () => {
						const active = view.file?.path;
						if (active !== path) return;
						this.applyCanvasChoice(path, !canvasForNote(path, this.settings.extendCanvasWhileScrolling));
					});
					canvas.classList.add("handwriting-canvas-action");
					const paper = view.addAction(paperIcon, "Paper background", () => {
						const active = view.file;
						if (!active || active.path !== path || !this.notePaper) return;
						const picker = new NotePaperPicker(this.app, path, this.notePaper.choice(active), async choice => {
							try { await this.notePaper?.save(active, choice); }
							catch { blockNotice("Could not save the paper background for this note."); }
						}, () => pickers.delete(picker));
						pickers.add(picker);
						picker.open();
					});
					actions.set(view, { path, canvas, paper });
					geometryChanged = true;
				}
				actions.get(view)?.canvas.classList.toggle("is-active", canvasForNote(path, this.settings.extendCanvasWhileScrolling));
			}
			for (const view of actions.keys()) if (!live.has(view)) { remove(view); geometryChanged = true; }
			// The strip watches pane size, not child changes in .view-actions.
			// Re-apply its existing corner once after the row gains or loses icons.
			if (geometryChanged) setToolbarCorner(getToolbarCorner());
		};
		this.headerActionRefresh = refresh;
		this.registerEvent(this.app.workspace.on("layout-change", refresh));
		this.registerEvent(this.app.workspace.on("file-open", refresh));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => {
			if (this.app.workspace.getLeavesOfType("markdown").some(leaf => (leaf.view as MarkdownView).file?.path === file.path)) refresh();
		}));
		this.register(onInkChanged(path => {
			if (Platform.isPhone) return;
			if (!this.app.workspace.getLeavesOfType("markdown").some(leaf => (leaf.view as MarkdownView).file?.path === path)) return;
			const showing = [...actions.values()].some(action => action.path === path);
			if (showing !== (inlineInk.inkPresence(path) === "ink")) refresh();
		}));
		this.register(onCanvasOverrideChanged(refresh));
		this.register(() => {
			for (const picker of pickers) picker.close();
			pickers.clear();
			for (const view of actions.keys()) remove(view);
			this.headerActionRefresh = null;
		});
		refresh();
	}

	/**
	 * Write one note's Infinite Canvas choice, from the menu or the command.
	 *
	 * The word on screen waits for the write. A frontmatter write can fail -
	 * the note can be deleted or replaced between the click and the write,
	 * which is the case `save` re-checks for - and a notice fired before the
	 * await would announce a choice the note never took.
	 */
	function applyCanvasChoice(this: HandwritingPlugin, path: string, choice: NoteCanvasChoice): void {
		runDetached((async () => {
			const written = await this.canvasOverride?.saveForPath(path, choice);
			if (written !== true) {
				new Notice("Handwriting: that note is gone - infinite canvas not changed");
				return;
			}
			// The override announces the change to every strip over this note;
			// this covers the global-resolving surfaces in the same move, so
			// nothing waits for a rebuild.
			refreshNoteZoomControlsAll();
			new Notice(
				choice === "default"
					? `Handwriting: Infinite canvas follows the setting (${this.settings.extendCanvasWhileScrolling ? "on" : "off"})`
					: `Handwriting: Infinite canvas ${choice ? "on" : "off"} for this note`
			);
		})(), "save the note's Infinite canvas override", () => {
			new Notice("Handwriting: could not write infinite canvas to that note");
		});
	}

export function installHeaderActions(proto: HandwritingPlugin): void {
	installMethods(proto, {
		refreshHeaderActions,
		registerHeaderActions,
		applyCanvasChoice,
	});
}
