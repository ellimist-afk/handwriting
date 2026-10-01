/**
 * A pen that is not the primary pointer, in real Chromium.
 *
 * On a Windows machine with a second mouse live beside the pen (a software
 * KVM such as lanmouse), Chromium reports the pen with `isPrimary: false` on
 * every event, pointerdown included. Headless Chromium cannot be made to do
 * that through its input pipeline: a pen driven over CDP is always primary,
 * with or without a mouse or a touch already down. So this page takes real,
 * trusted input from the driver and shadows `isPrimary` on the event object
 * itself, in a window-capture listener installed before anything else - the
 * browser still picks the target, sets up the pointer and honours capture,
 * and every listener in the plugin reads `isPrimary: false`, as on the device.
 *
 * The note half is a real CodeMirror note with the real overlay, pen router
 * and strip, on the desktop-Windows platform stub.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

installObsidianDom();
inlineInk.attachHost({
	readPageId: () => "existing-page",
	claimId: async () => ({ pageId: "existing-page" }),
	loadSidecar: async () => null,
	scheduleSidecar: () => {},
	scheduleSidecarNow: async () => {},
	notify: () => {},
} as never);

/** Which pointer types get `isPrimary: false`; empty = leave every event alone. */
let notPrimary = new Set<string>();
const seen: Array<{ type: string; pointerType: string; isPrimary: boolean; trusted: boolean }> = [];
for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]) {
	window.addEventListener(
		type,
		(e) => {
			const p = e as PointerEvent;
			if (notPrimary.has(p.pointerType)) Object.defineProperty(p, "isPrimary", { value: false });
			if (type === "pointerdown") seen.push({ type, pointerType: p.pointerType, isPrimary: p.isPrimary, trusted: p.isTrusted });
		},
		{ capture: true }
	);
}

const frames = async (n: number): Promise<void> => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};
const path = "pen-not-primary.md";
const strip = (): HTMLElement | null => document.querySelector(".handwriting-mobile-tools");
const pill = (): HTMLElement | null => document.querySelector(".handwriting-pen-pill");
const grip = (): HTMLElement | null => document.querySelector(".handwriting-tools-grip");
const tools = (): { setCollapsed(on: boolean): void; drag: unknown } | null =>
	((overlayForPath(path) as unknown as { mobileTools?: never } | null)?.mobileTools ?? null);

async function setupNote(): Promise<{ overlay: boolean }> {
	const host = document.body.appendChild(document.createElement("div"));
	host.className = "markdown-source-view";
	host.style.cssText = "width:1000px;height:700px;overflow:hidden;position:relative";
	const doc = Array.from({ length: 80 }, (_, i) => `${i} ${"some text ".repeat(8)}`).join("\n");
	new EditorView({
		parent: host,
		state: EditorState.create({
			doc,
			extensions: [
				editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} }) as never),
				inkOverlayExtension(),
				EditorView.theme({ "&": { width: "1000px", height: "700px" }, ".cm-scroller": { overflow: "auto" } }),
			],
		}),
	});
	await frames(6);
	setPenInk(true);
	await frames(2);
	return { overlay: overlayForPath(path) !== null };
}

/** Where the handle is, once the strip is up; folds the strip first for the pill. */
async function handleAt(which: "grip" | "pill"): Promise<{ x: number; y: number } | null> {
	await new Promise((r) => setTimeout(r, 400));
	await frames(4);
	if (which === "pill") {
		tools()?.setCollapsed(true);
		await frames(4);
	}
	const el = which === "grip" ? grip() : pill();
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function setNotPrimary(types: string[]): void {
	notPrimary = new Set(types);
	seen.length = 0;
}

/** Mid-drag: is the drag live, and does the handle hold the pointer's capture. */
function midDrag(which: "grip" | "pill", pointerId: number) {
	const el = which === "grip" ? grip() : pill();
	return {
		dragging: !!(strip()?.classList.contains("is-dragging") || pill()?.classList.contains("is-dragging")),
		captured: !!el && el.hasPointerCapture(pointerId),
		dragLive: tools()?.drag != null,
		downs: [...seen],
	};
}

function lastPenDownId(): number {
	return (window as unknown as { __lastPenId: number }).__lastPenId;
}
window.addEventListener("pointerdown", (e) => {
	(window as unknown as { __lastPenId: number }).__lastPenId = e.pointerId;
}, { capture: true });

(window as unknown as { __np: unknown }).__np = { setupNote, handleAt, setNotPrimary, midDrag, lastPenDownId, frames };
