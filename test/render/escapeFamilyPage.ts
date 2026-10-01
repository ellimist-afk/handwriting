import "./noteViewportCameraPage";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "./iphoneObsidianStub";
import { inkOverlayExtension, inlineInk, overlayForPath, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setTipMode, tipMode } from "../../src/inline/TipMode";
import { mouseActsAsPen, setMouseInk, toolIsLit } from "../../src/inline/MouseInk";
import { deviceHasNeverSeenAPen, markPenHardwareSeen, releaseMouseInkQuietly, setPenToolsMode } from "../../src/inline/PenToolsMode";
import { penInkEnabled } from "../../src/inline/PenInk";
import { NotePaperPicker } from "../../src/inline/NotePaper";
import { FoldOrderControl } from "../../src/inline/FoldOrderControl";
import { normalizeFoldOrder } from "../../src/inline/MobileTools";
import { PdfInkController } from "../../src/pdf/PdfInkController";
import HandwritingPlugin from "../../src/main";
import { setInkColorHex } from "../../src/ink/InkColor";
import { DEFAULT_PEN } from "../../src/ink/PenStyle";

const w = window as any;
let overlay: any;
let pop: Window | null = null;
let popView: EditorView | null = null;
let picker: NotePaperPicker | null = null;
let fold: any = null;
let settings: HTMLElement | null = null;
let pdf: any = null;
let lifecycle: {open(win: Window): void; close(win: Window): void} | null = null;
let popRetiredAtClose: boolean | null = null;
let closedListenerStayedQuiet: boolean | null = null;
const pdfInk = new Map<HTMLElement, PdfInkController>();
const disposers: Array<() => void> = [];
const state = () => ({
	tip: tipMode(),
	mouseClaimsInk: mouseActsAsPen("mouse", toolIsLit(penInkEnabled()), deviceHasNeverSeenAPen()),
	noteRouterClaimsMouse: overlay.router.mouseActsAsPen(new PointerEvent("pointerdown", {pointerType: "mouse"})),
	selected: overlay.selection.size,
	moreOpen: overlay.mobileTools?.moreOpen ?? false,
	inkPop: overlay.mobileTools?.hasOpenPop() ?? false,
	pickerOpen: !!picker?.modalEl.isConnected,
	focus: document.activeElement?.className,
	popClosed: pop?.closed ?? null,
	foldDragging: !!fold?.drag,
	settingsOpen: !!settings?.isConnected,
	pdfSelected: pdf?.selected.length ?? 0,
	popOverlay: !!overlayForPath("escape-popout.md"),
	popRetiredAtClose,
	closedListenerStayedQuiet,
	strokes: inlineInk.strokes("fit-escape.md").map(s => ({id: s.id, color: s.color, width: s.width, tool: s.tool})),
	caret: overlay.view.state.selection.main.head,
});

w.escapeFamily = {
	async setup(kind: string) {
		setPenToolsMode("show");
		await w.viewportFixture.setup("escape", "point");
		overlay = w.viewportFixture.overlay("escape");
		// Exercise the same lifecycle installation main.onload uses. On the old base it is absent.
		lifecycle = (HandwritingPlugin.prototype as any).installEscapeWindows?.call({
			pdfInk, pdfIds: new Map(), pdfFiles: new Map(), releasePdfId: () => {},
			register: (dispose: () => void) => disposers.push(dispose),
			app: {workspace: {onLayoutReady: (fn: () => void) => fn(), iterateAllLeaves: (fn: (leaf: unknown) => void) => fn({view: {containerEl: overlay.view.dom}})}},
		}) ?? null;
		overlay.view.focus();
		// Match the mouse tool's explicit armed state, not just the tip-mode value.
		setMouseInk(true);
		setTipMode(kind === "space" ? "space" : "pan");
		if (kind === "cursor-control") { setTipMode("nib"); releaseMouseInkQuietly(); }
		if (kind === "lasso") overlay.selection.selectExactly(["seed-0"]);
		if (kind.startsWith("popout")) {
			pop = window.open("about:blank", "escape-popout", "width=500,height=400");
			if (!pop) throw new Error("popout did not open");
			lifecycle?.open(pop);
			// Obsidian installs its element helpers in each window. Copy only those helpers.
			for (const key of Object.getOwnPropertyNames(HTMLElement.prototype)) {
				if (!(key in (pop as any).HTMLElement.prototype)) {
					Object.defineProperty((pop as any).HTMLElement.prototype, key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!);
				}
			}
			const parent = pop.document.body.appendChild(pop.document.createElement("div"));
			parent.className = "markdown-source-view";
			popView = new EditorView({ parent, state: EditorState.create({ doc: "popout note", extensions: [
				editorInfoField.init(() => ({app: {commands: {executeCommandById: () => false}}, file: {path: "escape-popout.md"}, editor: {}})),
				inkOverlayExtension(),
			] }) });
			await w.viewportFixture.settle();
			if (!overlayForPath("escape-popout.md")) throw new Error("popout overlay missing");
			popView.focus();
			// The window-close route must retire its overlays even before CodeMirror tears down.
			lifecycle?.close(pop);
			popRetiredAtClose = !overlayForPath("escape-popout.md");
			pop.document.body.dispatchEvent(new (pop as any).KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
			closedListenerStayedQuiet = tipMode() === "pan";
			popView.destroy();
			popView = null;
			pop.close();
			if (kind === "popout-editor") overlay.view.focus();
			else (document.activeElement as HTMLElement)?.blur();
		}
		if (kind === "folded-pop") overlay.mobileTools.setMoreOpen(true);
		if (kind === "paper-picker") {
			picker = new NotePaperPicker({} as never, "escape.md", "lines", async () => {}, () => {});
			picker.open();
		}
		if (kind === "fold-order-drag") {
			settings = document.body.appendChild(document.createElement("div"));
			settings.className = "modal";
			fold = new FoldOrderControl(settings, {order: () => normalizeFoldOrder([]), apply: () => {}, corner: () => "top-right", previewHost: overlay.mobileTools.host});
			// Model only the host settings shell; the drag consumer is production code.
			settings.addEventListener("keydown", ev => {
				if (ev.key !== "Escape" || ev.defaultPrevented) return;
				ev.preventDefault(); ev.stopPropagation();
				fold.destroy(); settings!.remove(); overlay.view.focus();
			});
			const grip = settings.querySelector<HTMLElement>(".handwriting-fold-grip")!;
			if (!grip) throw new Error("fold grip missing");
			grip.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, cancelable: true, pointerId: 71, button: 0}));
			if (!fold.drag) throw new Error("fold drag did not start");
		}
		if (kind === "pdf-selection") {
			const root = document.body.appendChild(document.createElement("div"));
			root.tabIndex = 0;
			pdf = new PdfInkController(root, window, () => [], () => "escape-pdf", () => []);
			pdfInk.set(root, pdf);
			// Use the controller's real selection/key handler; no PDF renderer is needed for deselection.
			pdf.selected = ["pdf-ink"]; pdf.selectionPage = 1;
			root.addEventListener("keydown", pdf.handleKeyDown, {capture: true});
			root.focus();
		}
		return state();
	},
	hostLayer(kind: string, consume: boolean, hidden = false) {
		const layer = document.body.appendChild(document.createElement("div"));
		layer.className = kind;
		layer.tabIndex = 0;
		layer.focus();
		if (hidden) { layer.blur(); layer.hidden = true; }
		const listener = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape") return;
			if (consume) { ev.preventDefault(); layer.remove(); document.removeEventListener("keydown", listener); }
		};
		document.addEventListener("keydown", listener);
		return state();
	},
	prepareNib(mode: "eraser" | "lasso") {
		markPenHardwareSeen();
		setInlineTool("pen"); setInkColorHex("pen", "#1977cc"); setInkSizeMult("pen", 2.5); setTipMode(mode);
		return {color: "#1977cc", width: DEFAULT_PEN.baseWidth * 2.5};
	},
	contactPoint() {
		const at = overlay.view.coordsAtPos(12);
		return {x: at.left + 1, y: (at.top + at.bottom) / 2};
	},
	async penStroke(eraser = false) {
		const rect = overlay.view.contentDOM.getBoundingClientRect();
		const point = {x: rect.left + 150, y: rect.top + 100};
		const fire = (type: string, dx: number) => {
			const x = point.x + dx, y = point.y + dx / 4;
			const target = document.elementFromPoint(x, y);
			if (!target) throw new Error("pen contact outside viewport");
			target.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerType: "pen", pointerId: 77,
				isPrimary: true, clientX: x, clientY: y, pressure: type === "pointerup" ? 0 : .6,
				buttons: type === "pointerup" ? 0 : eraser ? 32 : 1, button: type === "pointermove" ? -1 : eraser ? 5 : 0}));
		};
		fire("pointerdown", 0);
		for (const dx of [10,20,30,40]) fire("pointermove", dx);
		fire("pointerup", 40);
		await w.viewportFixture.settle();
		return state();
	},
	state,
};
