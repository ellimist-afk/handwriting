/**
 * A NOTE REOPENED AT A SAVED ZOOM HOLDS ITS LINE SIGNATURE.
 *
 * Mount asks CodeMirror for two measures in this order: the camera restore, then the line signature. CodeMirror runs
 * every measure's read before any write, so the signature is read at 100 percent; the restore's write then commits the
 * saved zoom, and the signature's write ran its zoom check against that saved zoom and refused. With no signature held,
 * no ink took its line's correction until the note was back at 100 percent. The check now tests the zoom the read was
 * taken at.
 *
 * The overlay is a real InkOverlayPlugin with mount stubbed; the two requests are the real armNoteCameraRestore and
 * requestLineSignature in mount's order, and the flush runs reads then writes as CodeMirror does. The camera commit is
 * stubbed to write the zoom: what it does to the box is not what is tested here. Node only; no DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { setNoteCameraStore } from "./NoteCamera";
import type { LineSignature } from "./LineAnchor";

const PATH = "reopened-zoomed.md";

interface Measure {
	key?: unknown;
	read: (view: unknown) => unknown;
	write: (value: never, view: unknown) => void;
}

interface Rig {
	overlay: InkOverlayPlugin & Record<string, unknown>;
	/** One CodeMirror measure cycle over everything asked for: every read first, then every write, in request order. */
	flush(): void;
	/** The signature the line anchors hold, or null. */
	held(): LineSignature | null;
}

let teardown: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.spyOn(InkOverlayPlugin.prototype, "mount").mockImplementation(() => {});
});

afterEach(() => {
	for (const undo of teardown.splice(0)) undo();
	setNoteCameraStore({ load: () => null, save: () => {} });
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function rig(savedZoom: number | null): Rig {
	setNoteCameraStore({
		load: () => (savedZoom === null ? null : { v: 1, cameras: { [PATH]: { zoom: savedZoom, left: 0, top: 0, at: 1 } } }),
		save: () => {},
	});
	const queue: Measure[] = [];
	const state = EditorState.create({ doc: "First line.\nSecond line.\n" });
	const view = {
		state,
		dispatch() {},
		scrollDOM: { scrollLeft: 0, scrollTop: 0 },
		contentDOM: { clientWidth: 700 },
		defaultCharacterWidth: 14,
		requestMeasure(m: Measure) {
			const at = m.key === undefined ? -1 : queue.findIndex((q) => q.key === m.key);
			if (at >= 0) queue[at] = m;
			else queue.push(m);
		},
	};
	const overlay = new InkOverlayPlugin(view as never) as InkOverlayPlugin & Record<string, unknown>;
	Object.assign(overlay, {
		filePath: () => PATH,
		container: {},
		retiring: false,
		canvasMode: true,
		pinchScaleNow: 1,
		contentStyle: { fontSize: "26px" },
		lineLayout: () => null,
		lineAnchorsMoved: () => {},
		lineAnchorsDrawn: () => {},
		unmount: () => {},
		// The camera commit, reduced to the zoom it writes.
		commitCameraScale(next: number): boolean {
			overlay.pinchScaleNow = next;
			return true;
		},
	});
	teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());
	const methods = overlay as unknown as { armNoteCameraRestore(path: string | null): void; requestLineSignature(): void };
	// Mount's order (InkOverlayLifecycle mount): the camera restore is armed, then the signature asked for.
	methods.armNoteCameraRestore(PATH);
	methods.requestLineSignature();
	return {
		overlay,
		flush() {
			const run = queue.splice(0);
			const read = run.map((m) => m.read(view));
			run.forEach((m, i) => m.write(read[i] as never, view));
		},
		held: () => overlay.lineAnchors.sig,
	};
}

describe("a note reopened at a saved zoom holds its line signature", () => {
	it("mount with a camera saved at 150 percent: one measure takes the signature read at 100 percent", () => {
		const r = rig(1.5);
		r.flush();
		expect(r.overlay.pinchScaleNow, "premise: the restore committed the saved zoom in the same measure").toBe(1.5);
		expect(r.held(), "no signature held: every anchor stays uncorrected until the note is back at 100 percent").not.toBeNull();
		expect(r.held()).toMatchObject({ width: 700, fontPx: 26, charWidth: 14 });
	});

	it("control: mount with no saved camera takes the signature as before", () => {
		const r = rig(null);
		r.flush();
		expect(r.overlay.pinchScaleNow).toBe(1);
		expect(r.held()).toMatchObject({ width: 700, fontPx: 26, charWidth: 14 });
	});

	it("control: a signature read while zoomed is still refused", () => {
		const r = rig(null);
		r.overlay.pinchScaleNow = 1.5;
		r.flush();
		expect(r.held(), "a read taken under the zoom's counter-sizing was held as the layout").toBeNull();
	});
});
