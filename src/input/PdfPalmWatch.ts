import { App, Platform } from "obsidian";
import { PalmShield, palmRadiusTrustworthy } from "./PalmShield";
import { PinchBridge } from "../pdf/PinchBridge";
import { findScaleFactor } from "../pdf/ScaleFactor";

/**
 * The palm shield for PDF panes on the release line, without any pdf ink.
 *
 * Drawing on pdfs is the 1.4 line's feature; palms zooming a pdf someone is
 * merely READING is not a drawing feature, it is the same shaped-contact bug
 * the note surface has, on the one surface that hands two-finger gestures to
 * the browser. So the watcher below attaches the shield to each pdf pane's
 * scroller and does nothing else - no pen, no overlay, no persistence.
 *
 * The viewer rebuilds its container on reload, so every sync re-checks the
 * element and re-attaches when it changed. Platform gate per window, because
 * a popout pane has its own navigator (and on Apple platforms the shield
 * stays off - see palmRadiusTrustworthy).
 */

// Most specific first. The two middle entries are pdf.js's own markup,
// which Obsidian embeds - present when its wrapper classes are not.
// No match at all does nothing: failing open is just today's behaviour.
const SCROLLER_SELECTORS = [
	".pdf-viewer-container",
	".pdfViewer",
	"#viewerContainer",
	".pdf-content-container",
];

export class PdfPalmWatch {
	private attached = new Map<HTMLElement, { el: HTMLElement; shield: PalmShield; bridge: PinchBridge }>();
	/** One observer per pane: the viewer builds its scroller AFTER the leaf
	 * appears and replaces it on internal rebuilds, with no layout event
	 * either time. Watching the pane is how the 1.4 line solved the same
	 * race for its ink; the shield needs the same eyes. */
	private observers = new Map<HTMLElement, MutationObserver>();
	private resyncQueued = false;

	constructor(private readonly app: App) {}

	/** Attach to every live pdf pane; drop panes that closed. */
	sync(): void {
		const seen = new Set<HTMLElement>();
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!root) continue;
			seen.add(root);
			if (Platform.isMobileApp) continue; // threshold is desktop-calibrated (see router)
			const win = root.ownerDocument.defaultView;
			if (!win || !palmRadiusTrustworthy(win.navigator)) continue;
			let el: HTMLElement | null = null;
			for (const sel of SCROLLER_SELECTORS) {
				el = root.querySelector(sel) as HTMLElement | null;
				if (el) break;
			}
			if (!this.observers.has(root)) {
				const ob = new (root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver)(() => this.queueSync());
				ob.observe(root, { childList: true, subtree: true });
				this.observers.set(root, ob);
			}
			if (!el) continue;
			const have = this.attached.get(root);
			if (have?.el === el) continue;
			have?.shield.dispose();
			have?.bridge.dispose();
			const shield = new PalmShield();
			shield.attach(el);
			// The viewer's own pinch re-centres away from the fingers; the
			// bridge re-issues it as the ctrl+wheel the viewer anchors right.
			// No pdf ink on this line, so the bridge is never mid-stroke.
			const scrollerEl = el;
			const bridge = new PinchBridge(
				() => true,
				() => {
					const page = scrollerEl.querySelector('div.page[data-page-number]');
					if (!(page instanceof HTMLElement)) return null;
					const w = scrollerEl.ownerDocument.defaultView;
					return w ? findScaleFactor(page, w) : null;
				}
			);
			bridge.attach(el);
			this.attached.set(root, { el, shield, bridge });
		}
		for (const [root, { shield, bridge }] of [...this.attached]) {
			if (seen.has(root)) continue;
			shield.dispose();
			bridge.dispose();
			this.attached.delete(root);
		}
		for (const [root, ob] of [...this.observers]) {
			if (seen.has(root)) continue;
			ob.disconnect();
			this.observers.delete(root);
		}
	}

	/** Coalesce observer bursts into one sync per frame. */
	private queueSync(): void {
		if (this.resyncQueued) return;
		this.resyncQueued = true;
		queueMicrotask(() => {
			this.resyncQueued = false;
			this.sync();
		});
	}

	dispose(): void {
		for (const { shield, bridge } of this.attached.values()) { shield.dispose(); bridge.dispose(); }
		this.attached.clear();
		for (const ob of this.observers.values()) ob.disconnect();
		this.observers.clear();
	}
}
