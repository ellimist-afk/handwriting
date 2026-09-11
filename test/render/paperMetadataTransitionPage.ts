import { NotePaper, NOTE_PAPER_ATTRIBUTE } from "../../src/inline/NotePaper";
import { updateMetadataVisibility } from "../../src/inline/MetadataVisibility";

type Choice = "default" | "none" | "lines" | "grid" | "dots";

function row(key: string, value: string): HTMLElement {

	const el = document.createElement("div");
	el.className = "metadata-property";
	el.dataset.propertyKey = key;
	el.textContent = `${key}: ${value}`;
	return el;
}

function snapshot(container: HTMLElement, root: HTMLElement): { paper: string | null; idOnly: boolean; rows: number; properties: string; userValue: string; display: string; background: string; paperDisplay: string; userDisplay: string; height: number } {
	const properties = root.querySelector<HTMLElement>(".metadata-container");
	const scroller = root.querySelector<HTMLElement>(".cm-scroller");
	const paperRow = root.querySelector<HTMLElement>('[data-property-key="handwriting-paper"]');
	const userRow = root.querySelector<HTMLElement>('[data-property-key="title"]');
	return {
		paper: container.getAttribute(NOTE_PAPER_ATTRIBUTE),
		idOnly: properties?.classList.contains("handwriting-metadata-id-only") ?? false,
		rows: root.querySelectorAll("[data-property-key]").length,
		properties: properties?.textContent ?? "",
		userValue: root.querySelector('[data-property-key="title"]')?.textContent ?? "",
		display: properties ? getComputedStyle(properties).display : "none",
		background: scroller ? getComputedStyle(scroller).backgroundImage : "none",
		paperDisplay: paperRow ? getComputedStyle(paperRow).display : "absent",
		userDisplay: userRow ? getComputedStyle(userRow).display : "absent",
		height: properties?.getBoundingClientRect().height ?? 0,
	};
}

function fakeFile(path: string): { path: string; extension: string } {
	return { path, extension: "md" };
}

export async function paperMetadataTransitionProbe(shippedCss: string): Promise<{
	transitions: Array<{ choice: Choice; state: ReturnType<typeof snapshot>; writes: string[] }>;
	remount: { before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot> };
	control: { unitCssCheck: boolean; layoutAssertion: boolean };
}> {
	const style = document.createElement("style");
	style.textContent = shippedCss;
	document.head.append(style);
	let container = document.createElement("div");
	const root = document.createElement("div");
	container.className = "view-content";
	root.className = "markdown-source-view is-live-preview show-properties";
	const scroller = document.createElement("div");
	scroller.className = "cm-scroller";
	root.append(scroller);
	const properties = document.createElement("div");
	properties.className = "metadata-container";
	const paperRow = row("handwriting-paper", "lines");
	properties.append(row("handwriting-page-id", "page-1"), paperRow);
	scroller.append(properties);
	container.append(root);
	document.body.append(container);

	const file = fakeFile("Paper transition.md");
	const writes: string[] = [];
	const frontmatter: Record<string, unknown> = { "handwriting-paper": "lines" };
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => path === file.path ? file : null,
			read: async () => "---\nhandwriting-paper: lines\n---\n",
		},
		fileManager: {
			processFrontMatter: async (_file: unknown, edit: (fm: Record<string, unknown>) => void) => {
				edit(frontmatter);
				writes.push(String(frontmatter["handwriting-paper"] ?? "default"));
			},
		},
		metadataCache: { getFileCache: () => ({ frontmatter }) },
		workspace: { getLeavesOfType: () => [{ view: { containerEl: container, file } }] },
	};
	const paper = new NotePaper(app as never, () => {});
	(paper as unknown as { ready: boolean }).ready = true;
	paper.refresh();
	updateMetadataVisibility(root, () => ["handwriting-page-id", "handwriting-paper"]);

	const transitions: Array<{ choice: Choice; state: ReturnType<typeof snapshot>; writes: string[] }> = [];
	for (const withUser of [false, true]) {
		if (withUser) frontmatter.title = "user value"; else delete frontmatter.title;
		for (const choice of ["none", "lines", "grid", "dots", "default"] as const) {
			await paper.save(file as never, choice);
			const keys = ["handwriting-page-id", ...Object.keys(frontmatter)];
			properties.replaceChildren(...keys.map(key => row(key, String(frontmatter[key]))));
			updateMetadataVisibility(root, () => keys);
			transitions.push({ choice, state: snapshot(container, root), writes: [...writes] });
		}
	}

	const before = snapshot(container, root);
	paper.destroy();
	container.remove();
	container = document.createElement("div");
	container.className = "view-content";
	const remountRoot = document.createElement("div");
	remountRoot.className = "markdown-source-view is-live-preview show-properties";
	const remountScroller = document.createElement("div");
	remountScroller.className = "cm-scroller";
	const remountProperties = document.createElement("div");
	remountProperties.className = "metadata-container";
	const remountKeys = ["handwriting-page-id", ...Object.keys(frontmatter)];
	remountProperties.append(...remountKeys.map(key => row(key, key === "handwriting-page-id" ? "page-1" : String(frontmatter[key]))));
	remountScroller.append(remountProperties);
	remountRoot.append(remountScroller);
	container.append(remountRoot);
	document.body.append(container);
	const remounted = new NotePaper(app as never, () => {});
	(remounted as unknown as { ready: boolean }).ready = true;
	remounted.refresh();
	updateMetadataVisibility(remountRoot, () => ["handwriting-page-id", "title"]);
	const after = snapshot(container, remountRoot);

	// Sensitivity control: a unit selector check passes while forced mounted
	// visibility keeps the repaired paper row visible.
	const referenceStyle = document.createElement("style");
	referenceStyle.textContent = ".reference-paper { display: block !important; }";
	document.head.append(referenceStyle);
	const referenceHost = document.createElement("div");
	referenceHost.className = "view-content";
	const referenceRoot = document.createElement("div");
	referenceRoot.className = "markdown-source-view is-live-preview show-properties";
	const referenceScroller = document.createElement("div");
	referenceScroller.className = "cm-scroller";
	referenceScroller.textContent = "mounted note";
	referenceRoot.append(referenceScroller);
	const referenceProperties = document.createElement("div");
	referenceProperties.className = "metadata-container";
	const referencePaper = row("handwriting-paper", "lines");
	referencePaper.className += " reference-paper";
	referencePaper.style.setProperty("display", "block", "important");
	referenceProperties.append(row("handwriting-page-id", "page-1"), referencePaper, row("title", "user value"));
	referenceRoot.append(referenceProperties);
	referenceHost.append(referenceRoot);
	document.body.append(referenceHost);
	const control = { unitCssCheck: referenceStyle.textContent.includes("reference-paper"), layoutAssertion: getComputedStyle(referencePaper).display === "none" };

	container.remove();
	style.remove();
	referenceHost.remove();
	referenceStyle.remove();
	return { transitions, remount: { before, after }, control };
}

declare global { interface Window { paperMetadataTransitionProbe: typeof paperMetadataTransitionProbe } }
window.paperMetadataTransitionProbe = paperMetadataTransitionProbe;
