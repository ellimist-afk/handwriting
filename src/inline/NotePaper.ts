import { Modal, TFile, type MarkdownView, type App, type CachedMetadata, type Plugin } from "obsidian";
import { PAPER_STYLES, paperClass, type PaperStyle } from "./Paper";
import { noteChoiceSource, pageIdForPath, readHint, writeHint } from "./NoteChoiceHint";

export const NOTE_PAPER_KEY = "handwriting-paper";
export const NOTE_PAPER_ATTRIBUTE = "data-handwriting-paper";
export type NotePaperChoice = PaperStyle | "default";

export function notePaperChoice(raw: unknown): NotePaperChoice {
	return PAPER_STYLES.includes(raw as PaperStyle) ? raw as PaperStyle : "default";
}

/** Per-note overrides of the existing editing background; never touches ink. */
export class NotePaper {
	private ready = false;
	private stopped = false;
	private readonly containers = new Set<HTMLElement>();
	private readonly saved = new Map<TFile, NotePaperChoice>();
	private readonly writes = new Map<TFile, Promise<void>>();
	private readonly revisions = new Map<TFile, number>();
	private revision = 0;
	private readonly pickers = new Set<NotePaperPicker>();

	private readonly stopChoices: (() => void) | null;

	constructor(private app: App, private notify: (message: string) => void) {
		// The ink file is read after the note shows: when it arrives, or
		// another device's file is adopted, the paper follows it and so does
		// this device's hint.
		const store = noteChoiceSource();
		this.stopChoices = store
			? store.onNoteChoicesChanged((path) => {
					if (this.stopped) return;
					writeHint(this.app, path, store.noteChoices(path));
					this.refresh();
			  })
			: null;
	}

	start(owner: Plugin): void {
		const refresh = (): void => this.refresh();
		owner.registerEvent(this.app.workspace.on("layout-change", refresh));
		owner.registerEvent(this.app.workspace.on("file-open", refresh));
		owner.registerEvent(this.app.workspace.on("window-open", refresh));
		owner.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (this.stopped || !(file instanceof TFile) || file.extension !== "md") return;
			menu.addItem(item => item.setTitle("Paper background").setIcon("file-text").onClick(() => {
				if (this.stopped) return;
				const picker: NotePaperPicker = new NotePaperPicker(this.app, file.path, this.choice(file), async choice => {
					try { await this.save(file, choice); }
					catch { this.notify("Could not save the paper background for this note."); }
				}, () => this.pickers.delete(picker));
				this.pickers.add(picker);
				picker.open();
			}));
		}));
		owner.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => {
			void this.metadataChanged(file, data, cache);
		}));
		owner.register(() => this.destroy());
		this.app.workspace.onLayoutReady(() => {
			if (this.stopped) return;
			this.ready = true;
			this.refresh();
		});
	}

	/**
	 * The note's paper: its ink file's choice once the file is read, this
	 * device's hint before that, else the old property line (still read, so a
	 * note that has one keeps its look), else the global setting.
	 */
	choice(file: TFile): NotePaperChoice {
		const saved = this.saved.get(file);
		if (saved !== undefined) return saved;
		const own = this.ownChoice(file.path);
		if (own !== undefined) return own;
		return notePaperChoice(this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_PAPER_KEY]);
	}

	private ownChoice(path: string): NotePaperChoice | undefined {
		const known = noteChoiceSource()?.noteChoices(path);
		if (known?.known) return known.paper;
		const id = pageIdForPath(this.app, path);
		const hint = id ? readHint(this.app, id) : null;
		const choice = notePaperChoice(hint?.p);
		return choice === "default" ? undefined : choice;
	}

	refresh(): void {
		if (!this.ready || this.stopped) return;
		const live = new Set<HTMLElement>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			const container = view.containerEl;
			live.add(container);
			const choice = view.file?.extension === "md" ? this.choice(view.file) : "default";
			if (choice === "default") container.removeAttribute(NOTE_PAPER_ATTRIBUTE);
			else container.setAttribute(NOTE_PAPER_ATTRIBUTE, choice);
		}
		for (const container of this.containers) {
			if (!live.has(container)) container.removeAttribute(NOTE_PAPER_ATTRIBUTE);
		}
		this.containers.clear();
		for (const container of live) this.containers.add(container);
	}

	private async metadataChanged(file: TFile, data: string, cache: CachedMetadata): Promise<void> {
		if (this.stopped || file.extension !== "md") return;
		const revision = ++this.revision;
		this.revisions.set(file, revision);
		const choice = notePaperChoice(cache.frontmatter?.[NOTE_PAPER_KEY]);
		if (this.saved.has(file) && this.saved.get(file) !== choice) {
			// A queued pre-save cache event must not undo the immediate saved
			// choice. A newer external edit may supersede it: verify that event
			// against the file only while waiting for our own cache to catch up.
			try {
				if (await this.app.vault.read(file) !== data) {
					if (this.revisions.get(file) === revision) this.revisions.delete(file);
					return;
				}
			} catch {
				if (this.revisions.get(file) === revision) this.revisions.delete(file);
				return;
			}
		}
		if (this.stopped || this.revisions.get(file) !== revision) return;
		this.revisions.delete(file);
		this.saved.delete(file);
		this.refresh();
	}

	/**
	 * The choice goes to the note's ink file. The old property line, when
	 * the note has one, is removed in the same action; a note without one is
	 * not edited. With no ink store (a suite that never loads the overlay)
	 * the property is written as before.
	 */
	async save(file: TFile, choice: NotePaperChoice): Promise<void> {
		const previous = this.writes.get(file) ?? Promise.resolve();
		const write = previous.catch(() => {}).then(async () => {
			if (this.stopped) return;
			if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("Paper background target no longer exists");
			const store = noteChoiceSource();
			if (store) {
				if (!(await store.setNoteChoice(file.path, "paper", choice))) throw new Error("Paper background could not be saved");
				if (this.stopped) return;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (fm && Object.prototype.hasOwnProperty.call(fm, NOTE_PAPER_KEY)) {
					await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
						delete frontmatter[NOTE_PAPER_KEY];
					});
				}
				if (this.stopped) return;
				this.revisions.delete(file);
				this.saved.delete(file);
				writeHint(this.app, file.path, store.noteChoices(file.path));
				this.refresh();
				return;
			}
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				if (choice === "default") delete frontmatter[NOTE_PAPER_KEY];
				else frontmatter[NOTE_PAPER_KEY] = choice;
			});
			if (this.stopped) return;
			this.revisions.delete(file);
			this.saved.set(file, choice);
			if (notePaperChoice(this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_PAPER_KEY]) === choice) {
				this.saved.delete(file);
			}
			this.refresh();
		});
		this.writes.set(file, write);
		try { await write; }
		finally { if (this.writes.get(file) === write) this.writes.delete(file); }
	}

	destroy(): void {
		this.stopped = true;
		this.stopChoices?.();
		for (const picker of this.pickers) picker.close();
		this.pickers.clear();
		for (const container of this.containers) container.removeAttribute(NOTE_PAPER_ATTRIBUTE);
		this.containers.clear();
		this.saved.clear();
		this.revisions.clear();
	}
}

const PAPER_CHOICES: readonly NotePaperChoice[] = ["default", "none", "lines", "grid", "dots"];
const PAPER_LABELS: Record<NotePaperChoice, string> = { default: "Global", none: "None", lines: "Lines", grid: "Grid", dots: "Dots" };

export class NotePaperPicker extends Modal {
	private selected = false;
	private returnFocus: HTMLElement | null = null;
	constructor(app: App, private path: string, private current: NotePaperChoice,
		private choose: (choice: NotePaperChoice) => Promise<void>, private closed: () => void) {
		super(app);
		this.returnFocus = this.modalEl.ownerDocument.activeElement as HTMLElement | null;
		this.setTitle("Paper background");
		this.modalEl.addClass("handwriting-paper-picker");
		this.modalEl.setAttribute("aria-label", "Paper background");
	}
	onOpen(): void {
		const doc = this.modalEl.ownerDocument;
		this.contentEl.empty();
		this.contentEl.createDiv({ cls: "handwriting-paper-picker-note", text: this.path });
		const grid = this.contentEl.createDiv({ cls: "handwriting-paper-picker-grid", attr: { role: "group", "aria-label": "Paper background choices" } });
		const inherited = PAPER_STYLES.find(style => {
			const cls = paperClass(style);
			return cls !== null && doc.body.classList.contains(cls);
		}) ?? "none";
		const buttons = PAPER_CHOICES.map(choice => {
			const active = choice === this.current;
			const button = grid.createEl("button", { cls: "handwriting-paper-tile", attr: {
				type: "button", "data-choice": choice, "aria-pressed": String(active),
			} });
			const swatch = button.createSpan({ cls: "handwriting-paper-swatch", attr: {
				"data-paper": choice === "default" ? inherited : choice, "aria-hidden": "true",
			} });
			if (active) swatch.createSpan({ cls: "handwriting-paper-check", text: "✓" });
			const label = button.createSpan({ cls: "handwriting-paper-tile-label", text: PAPER_LABELS[choice] });
			if (choice === "default") label.createSpan({ cls: "handwriting-paper-inherited", text: `Uses global setting · ${PAPER_LABELS[inherited]}` });
			button.addEventListener("click", () => { void this.selectChoice(choice); });
			return button;
		});
		grid.addEventListener("keydown", event => {
			const at = buttons.indexOf(doc.activeElement as HTMLButtonElement);
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); return; }
			if (at < 0) return;
			let next = at;
			if (event.key === "ArrowRight") next = (at + 1) % buttons.length;
			else if (event.key === "ArrowLeft") next = (at + buttons.length - 1) % buttons.length;
			else if (event.key === "ArrowDown") next = at === 0 ? 1 : Math.min(4, at + 2);
			else if (event.key === "ArrowUp") next = Math.max(0, at - 2);
			else if (event.key === "Home") next = 0;
			else if (event.key === "End") next = buttons.length - 1;
			else return;
			event.preventDefault();
			buttons[next]?.focus();
		});
		buttons[PAPER_CHOICES.indexOf(this.current)]?.focus();
	}
	async selectChoice(choice: NotePaperChoice): Promise<void> {
		if (this.selected) return;
		this.selected = true;
		this.close();
		await this.choose(choice);
	}
	onClose(): void {
		this.selected = true;
		this.closed();
		if (this.returnFocus?.isConnected) this.returnFocus.focus();
	}
}
