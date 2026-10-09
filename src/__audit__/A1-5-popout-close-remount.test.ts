/**
 * An overlay destroyed when its popout window closes does not mount again.
 *
 * When a popout window closes, main.ts's "window-close" handler calls closeInlineInkDocument, which destroys every
 * overlay in that window's document: destroy() takes the overlay out of `instances` and unmounts it. The editor
 * itself is destroyed later. In Obsidian 1.13.7 (app.js, read for this file) WorkspaceWindow.close detaches each leaf
 * (View.close: containerEl.detach(), unload(), then `await onClose()`), then triggers "window-close"; MarkdownView's
 * onClose awaits FileView.onClose (the final save) before editMode.destroy() runs. So for at least that await the
 * closed window's editor is still alive with the overlay already destroyed.
 *
 * If a CodeMirror update reaches the overlay in that window, updateInner sees no container and mounts again
 * (`if (!this.container) { if (enabled) this.mount(); }`); ownsMarkdownEditorRoot reads the detached DOM and still
 * says yes. That overlay is no longer in `instances`, so the editor's own destroy() returns at once and never
 * unmounts it: its router, observers, listeners and reticle on the closed window's body are never released.
 *
 * MEASURED here: the overlay-level sequence (the real constructor, closeInlineInkDocument, update and destroy). The
 * real mount runs its guard and stops at its editor-info check (this environment has no DOM); a mount counts when it
 * got past the guard, and then the mount's work is recorded, not run. unmount is recorded. NOT CHECKED: whether Obsidian actually
 * dispatches a CodeMirror update to that editor between "window-close" and its destroy. Nothing seen on screen.
 *
 * Expected: red until an overlay its window has closed cannot mount again.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin, closeInlineInkDocument } from "../inline/InkOverlay";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	const g = globalThis as Record<string, unknown>;
	if (typeof g.ResizeObserver !== "function") vi.stubGlobal("ResizeObserver", NoopObserver);
	if (typeof g.MutationObserver !== "function") vi.stubGlobal("MutationObserver", NoopObserver);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("an overlay destroyed when its popout closes is not mounted again by a late editor update", () => {
	const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
	let mounts = 0;
	let unmounts = 0;
	const realMount = InkOverlayPlugin.prototype.mount;
	vi.spyOn(InkOverlayPlugin.prototype, "mount").mockImplementation(function (this: InkOverlayPlugin) {
		const o = this as unknown as { container: unknown; retiring: boolean };
		// The real mount's first act past its guard is `retiring = false`; with no editor info it then returns.
		o.retiring = true;
		realMount.call(this);
		if (o.retiring) return;
		mounts++;
		o.container = {};
	});
	vi.spyOn(InkOverlayPlugin.prototype, "unmount").mockImplementation(function (this: InkOverlayPlugin) {
		unmounts++;
		(this as unknown as { container: unknown }).container = null;
	});

	const popoutDoc = {} as Document;
	const view = { dom: { ownerDocument: popoutDoc }, state: { field: () => undefined } };
	const overlay = new InkOverlayPlugin(view as never);
	(overlay as unknown as { ownsMarkdownEditorRoot: () => boolean }).ownsMarkdownEditorRoot = () => true;
	expect(mounts, "precondition: the overlay mounted once in the popout").toBe(1);

	closeInlineInkDocument(popoutDoc); // main.ts "window-close"
	expect(unmounts, "precondition: the window close tore it down").toBe(1);

	// A CodeMirror update reaches the closed window's editor before Obsidian destroys it.
	proto.update!.call(overlay, { transactions: [], docChanged: false, geometryChanged: false, viewportChanged: false } as never);
	expect.soft(mounts, "the destroyed overlay mounted again").toBe(1);

	// The editor's own teardown: CodeMirror destroys its plugins.
	overlay.destroy();
	expect((overlay as unknown as { container: unknown }).container, "never released: still mounted after the editor's destroy").toBeNull();
});
