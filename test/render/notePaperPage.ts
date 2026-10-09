import { type App, type CachedMetadata, type Plugin, type TFile } from "obsidian";
import { NotePaper, NOTE_PAPER_KEY, NOTE_PAPER_ATTRIBUTE } from "../../src/inline/NotePaper";

export function paperProbe(css: string) {
	document.body.replaceChildren();
	const style = document.createElement("style"); style.textContent = css; document.head.append(style);
	const iframe = document.createElement("iframe"); document.body.append(iframe);
	const popout = iframe.contentDocument!;
	const popoutStyle = popout.createElement("style"); popoutStyle.textContent = css; popout.head.append(popoutStyle);
	const docs = [document, popout];
	for (const doc of docs) {
		doc.body.className = "handwriting-paper-grid";
		doc.body.style.setProperty("--background-modifier-border", "#777777");
	}
	const a = { path: "a.md", extension: "md" } as TFile;
	const b = { path: "b.md", extension: "md" } as TFile;
	const c = { path: "plain.md", extension: "md" } as TFile;
	const cache = new Map<TFile, CachedMetadata>([[a, { frontmatter: { [NOTE_PAPER_KEY]: "lines" } }], [b, { frontmatter: { [NOTE_PAPER_KEY]: "none" } }]]);
	function leaf(doc: Document, file: TFile) {
		const containerEl = doc.createElement("div"); containerEl.className = "workspace-leaf-content";
		containerEl.innerHTML = '<div class="markdown-source-view"><div class="cm-scroller">note text</div></div><div class="markdown-preview-view">reading text</div><div class="pdf-viewer">PDF</div>';
		doc.body.append(containerEl);
		return { view: { file, containerEl } };
	}
	const leaves = [leaf(document, a), leaf(document, b), leaf(document, c), leaf(popout, a)];
	const events = new Map<string, (...args: any[]) => void>();
	let writes = 0;
	const app = {
		workspace: { getLeavesOfType: () => leaves, on: (event: string, cb: (...args: any[]) => void) => events.set(event, cb), onLayoutReady: (cb: () => void) => cb() },
		metadataCache: { getFileCache: (file: TFile) => cache.get(file), on: (event: string, cb: (...args: any[]) => void) => events.set(event, cb) },
		fileManager: { processFrontMatter: () => { writes++; } },
		vault: { getAbstractFileByPath: (path: string) => [a, b, c].find(file => file.path === path) ?? null },
	} as unknown as App;
	const paper = new NotePaper(app, () => {});
	paper.start({ registerEvent: () => {}, register: () => {} } as unknown as Plugin);
	const read = () => leaves.map(({ view }) => {
		const win = view.containerEl.ownerDocument.defaultView!;
		const computed = win.getComputedStyle(view.containerEl.querySelector(".cm-scroller")!);
		return { image: computed.backgroundImage, size: computed.backgroundSize, attachment: computed.backgroundAttachment,
			attribute: view.containerEl.getAttribute(NOTE_PAPER_ATTRIBUTE), text: view.containerEl.textContent,
			reading: win.getComputedStyle(view.containerEl.querySelector(".markdown-preview-view")!).backgroundImage,
			pdf: win.getComputedStyle(view.containerEl.querySelector(".pdf-viewer")!).backgroundImage };
	});
	const initial = read();
	cache.set(a, { frontmatter: { [NOTE_PAPER_KEY]: "dots" } });
	events.get("changed")!(a, "", cache.get(a));
	const changed = read();
	leaves[0]!.view.file = b;
	events.get("file-open")!();
	for (const doc of docs) doc.body.className = "handwriting-paper-lines";
	paper.refresh();
	const switched = read();
	const matrix = [];
	for (const global of ["none", "lines", "grid", "dots"] as const) {
		for (const doc of docs) doc.body.className = global === "none" ? "" : `handwriting-paper-${global}`;
		for (const override of ["default", "none", "lines", "grid", "dots"] as const) {
			cache.set(a, { frontmatter: override === "default" ? {} : { [NOTE_PAPER_KEY]: override } });
			events.get("changed")!(a, "", cache.get(a));
			matrix.push({ global, override, result: read()[3]! });
		}
	}
	for (const doc of docs) doc.body.className = "handwriting-paper-lines";
	paper.destroy();
	const cleared = read();
	return { initial, changed, switched, cleared, matrix, writes };
}

declare global { interface Window { paperProbe: typeof paperProbe; } }
window.paperProbe = paperProbe;
