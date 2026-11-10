/**
 * The pin: a small pin on an attached group's word. Drag it onto another word and the group attaches there, with the
 * same id and the same strokes, in one undo step, and no ink moves. A drop on a line's blank part takes the paragraph.
 * The pin shows while its group is selected, and always on a group that needs reattachment, whose tag reads the words
 * Alan gave. A pen tip on an unselected group's pin inks (the nib always inks); a mouse or a finger works it.
 *
 * Driven on the bare overlay of attachTapRig.test.util.ts: the real lasso contact (lassoDown, lassoMove, lassoUp), the
 * real finger tap (tapReleasesSelection), the real chrome and committed paint, with a view whose line and word reads
 * are worked out from the rig's note: lines 40 world units tall, 14 units a character from x 10.
 */
import { describe, expect, it } from "vitest";
import { inlineInk } from "./InkOverlayRegistry";
import * as Decoration from "./AttachDecoration";
import { ATTACH_STRINGS, attachChrome } from "./AttachDecoration";

/** One pin as the chrome shows it: its group, its point (the pin's tip, world units), and whether the group is held. */
type AttachPin = { id: string; at: { x: number; y: number }; held: boolean };
/** Read through the module, so a build without pins fails on the call, not at load. */
const attachPinsOf = (...a: unknown[]): AttachPin[] => {
	const f = (Decoration as unknown as { attachPinsOf?: (...a: unknown[]) => AttachPin[] }).attachPinsOf;
	if (typeof f !== "function") throw new Error("attachPinsOf is not exported");
	return f(...a);
};
import { invertInkOp, type InkOp } from "./InkHistory";
import { InkOverlayPlugin } from "./InkOverlay";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { doc, tapRig, SHOWN, type RigOpts } from "./attachTapRig.test.util";
import type { AttachmentRecord } from "./InkAttachments";
import type { TransactionSpec } from "@codemirror/state";
import { attachButtonPoint } from "./LassoTransform";

type Bounds = { x: number; y: number; width: number; height: number };

const G1 = ["c1", "c2"];
const CHAR = 14, LEFT = 10;

/** Where a document position sits, world units at zoom 1: its line's top plus 8, 24 tall; 14 a character from x 10. */
function placeOf(pos: number) {
	const line = doc.lineAt(pos), top = (line.number - 1) * 40 + 8;
	return { left: LEFT + (pos - line.from) * CHAR, top, bottom: top + 24 };
}

function pinRig(path: string, opts: RigOpts = {}) {
	const r = tapRig(path, opts);
	Object.assign((r.overlay as unknown as { view: object }).view, {
		scaleY: 1,
		defaultLineHeight: 40,
		viewport: { from: 0, to: doc.length },
		lineBlockAt: (pos: number) => ({ top: (doc.lineAt(pos).number - 1) * 40, bottom: doc.lineAt(pos).number * 40 }),
		lineBlockAtHeight: (h: number) => {
			const line = doc.line(Math.max(1, Math.min(doc.lines, Math.floor(h / 40) + 1)));
			return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
		},
		coordsAtPos: (pos: number) => {
			const p = placeOf(pos);
			return { left: p.left, right: p.left, top: p.top, bottom: p.bottom };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	});
	Object.assign(r.overlay, {
		fontZoom: 1,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		inkInputPanX: () => 0,
		inkInputPanY: () => 0,
		pinchHeld: () => false,
		// A frame held by a contact: the committed paint arms no overview build.
		frame: { locked: true, begin: () => {}, end: () => {} },
		followRefAt: (pos: number) => ({ x: placeOf(pos).left, y: placeOf(pos).top }),
		endLiveGestureForHistory: () => {},
		repaintPath: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
	});
	const o = r.overlay as unknown as {
		lassoDown(s: object, input: string): void;
		lassoMove(s: object[]): void;
		lassoUp(): void;
		applyInkOp(op: InkOp, record: boolean): void;
	};
	const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	/** A drag from (x0, y0) to (x1, y1) through the lasso. */
	const drag = (x0: number, y0: number, x1: number, y1: number, input: "pen" | "mouse" | "touch") => {
		o.lassoDown(sample(x0, y0), input);
		o.lassoMove([sample((x0 + x1) / 2, (y0 + y1) / 2)]);
		o.lassoMove([sample(x1, y1)]);
		o.lassoUp();
	};
	const group = (id: string) => inlineInk.attachments(path).find((a) => a.id === id) as AttachmentRecord;
	const shown = () => {
		r.anchors.follow.setList(inlineInk.attachments(path));
		return r.anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => ({ id: s.id, x: s.points[0]!.x, y: s.points[0]!.y }));
	};
	const pins = (): AttachPin[] => attachPinsOf(r.overlay, inlineInk.attachments(path), inlineInk.strokes(path), inlineInk.generation(path));
	return { ...r, o, sample, drag, group, shown, pins, path };
}

/**
 * The pen path on the pin rig: the real penDown and penUp, with the moves sent to lassoMove as the router's onPenRaw
 * does in lasso mode. penDown's and penUp's reach into the editor, the strip, the cursors and the extent is stood down:
 * none is the subject. `wetDowns` counts ink strokes begun.
 */
function penPath(r: ReturnType<typeof pinRig>) {
	Object.assign((r.overlay as unknown as { view: object }).view, { hasFocus: true, focus: () => {} });
	const wetDowns: unknown[] = [];
	const wet = { shape: true, beginStroke: (...a: unknown[]) => void wetDowns.push(a), contactHalfWidth: () => 1, clear: () => {} };
	Object.assign(r.overlay, {
		mode: "ink", router: null, mobileTools: null, noteZoomControls: null, penCursorEl: null,
		penStyle: { ...DEFAULT_PEN }, highlighterStyle: { ...DEFAULT_PEN }, wet, highlightWet: wet, predReal: [], predLastTail: [],
		frame: { locked: false, begin: () => {}, end: () => {}, cancel: () => {} },
		syncCamera: () => {}, captureProbeGeometry: () => {}, recordPenDownState: () => {}, startFrameTicker: () => {},
		ensurePenTools: () => {}, probeSample: () => {}, showEraserCursor: () => {}, showLassoCursor: () => {}, hideLassoCursor: () => {},
		retryCanvasOffReset: () => {}, releaseHeldFontRef: () => {}, replayDeferredResize: () => {}, scheduleViewportStyleRefresh: () => {},
		updateExtent: () => {}, resumeStrandedPan: () => {}, stopFrameTicker: () => {}, hidePenCursor: () => {},
		bandSyncDeferred: false, snapPreview: null, viewportStyleDirty: false, leftReserveHeld: 0,
	});
	const proto = InkOverlayPlugin.prototype as unknown as { penDown(s: object, ev: object): void; penUp(ev?: object): void };
	const o = r.overlay as unknown as { mode: string; pinPress: unknown };
	const down = (x: number, y: number, pointerType: "pen" | "mouse") =>
		proto.penDown.call(r.overlay, r.sample(x, y), { type: "pointerdown", pointerType, button: 0, buttons: 1 });
	const move = (x: number, y: number) => {
		if (o.mode === "lasso") r.o.lassoMove([r.sample(x, y)]);
	};
	const up = (ev?: { type: string; pointerType?: string }) => proto.penUp.call(r.overlay, ev);
	return { down, move, up, o, wetDowns };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
/** The ink history steps sent, leaving out the text mark's effects. */
const steps = (sent: TransactionSpec[]) => sent.filter((spec) => ops(spec).some((op) => typeof (op as { type?: unknown } | null)?.type === "string"));
/** Let the measure's write and its microtask run. */
const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
/** Line n's word at character `col`, as the drop target should read it. */
const wordOn = (n: number, from: number, text: string) => ({ kind: "range", from: doc.line(n).from + from, to: doc.line(n).from + from + text.length, text });

describe("the pin shows on the group's word", () => {
	it("a selected group that follows its text shows its pin at the start of its words", () => {
		// Defect (1.5.0): no pin; the only way to move a hook is the timed pick, pen only, a paragraph only.
		const r = pinRig("pin-shows.md");
		r.selection.selectExactly(G1);
		const calls = r.redraw();
		// g1's record reads its word at READ (6, 92): the pin's point is there.
		expect(calls.filter((c) => c.startsWith("pin ")), "one pin, at g1's word").toEqual(["pin 6,92"]);
		expect(r.pins()).toEqual([{ id: "g1", at: { x: 6, y: 92 }, held: false }]);
	});

	it("CONTROL: a group that follows its text and is not selected shows no pin", () => {
		const r = pinRig("pin-none.md");
		r.redraw();
		expect(r.pins()).toEqual([]);
	});

	it("a group that needs reattachment shows its pin selected or not, left of its tag, and its tag reads Alan's words", () => {
		// Defect (1.5.0): the held group shows "Needs reattachment" and no pin.
		const r = pinRig("pin-held.md", { held: ["g1"] });
		r.redraw();
		const box = r.shownBox(G1);
		const want = { id: "g1", at: { x: box.x - 14, y: box.y - 8 }, held: true };
		expect(r.pins(), "nothing selected").toEqual([want]);
		r.selection.selectExactly(G1);
		r.redraw();
		expect(r.pins(), "selected").toEqual([want]);
		expect(ATTACH_STRINGS.needs).toBe("Drag the pin to the text");
		expect(attachChrome([{ id: "g1", box, needs: true }], []).labels.map((l) => l.text)).toEqual([ATTACH_STRINGS.needs]);
	});

	it("the committed layer draws the held group's pin and the tag with nothing selected", () => {
		const r = pinRig("pin-held-paint.md", { held: ["g1"] });
		r.redraw();
		const ops = r.paint("all");
		expect(ops.filter((op) => op.startsWith(`fillText ${ATTACH_STRINGS.needs},`)), "the tag").toHaveLength(1);
		const box = r.shownBox(G1);
		// The pin's head: a disc 13 css px above its point.
		expect(ops, "the pin's head").toContain(`arc ${box.x - 14},${box.y - 8 - 13},5,0,6.28`);
	});
});

describe("dragging the pin moves the hook, never the ink", () => {
	it("a pen drags the selected group's pin onto a word on another line: same id, same strokes, that word, one step, no ink moves", async () => {
		const r = pinRig("pin-drag-word.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const before = r.shown(), old = r.group("g1");
		const head = { x: 6, y: 92 - 13 };
		// "words" on line 10: characters 8 to 13, x 122 to 192; the row's middle y 380.
		r.drag(head.x, head.y, 150, 380, "pen");
		await settle();
		const g = r.group("g1");
		expect([g.id, [...g.strokeIds].sort()]).toEqual(["g1", G1]);
		expect(g.target).toMatchObject(wordOn(10, 8, "words"));
		expect(r.shown(), "no ink moved").toEqual(before);
		expect(steps(r.sent), "one history step").toHaveLength(1);
		const step = ops(steps(r.sent)[0]!);
		expect(step.map((op) => op.type), "the step is the attach alone").toEqual(["attach"]);
		const undo = invertInkOp(step[0]!) as { after: AttachmentRecord | null };
		expect(undo.after?.target, "its undo puts the old hook back").toEqual(old.target);
		expect(r.selected(), "the group stays selected").toEqual(G1);
	});

	it("a drop on a line's blank part takes that line's paragraph", async () => {
		const r = pinRig("pin-drag-paragraph.md");
		r.selection.selectExactly(G1);
		r.redraw();
		r.drag(6, 92 - 13, 500, 380, "mouse");
		await settle();
		expect(r.group("g1").target).toMatchObject({ kind: "paragraph", text: "line 10 words" });
	});

	it("a mouse drags an unselected held group's pin onto a word: it attaches there and follows its text", async () => {
		const r = pinRig("pin-drag-held.md", { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const pin = r.pins()[0]!;
		r.drag(pin.at.x, pin.at.y - 13, 150, 380, "mouse");
		await settle();
		expect(r.group("g1").target).toMatchObject(wordOn(10, 8, "words"));
		expect(r.anchors.follow.followsText("g1"), "it follows its new text").toBe(true);
	});

	it("a press on the pin that does not move changes nothing: the pin takes it, so the box under it does not drag", async () => {
		const r = pinRig("pin-press.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const old = r.group("g1");
		r.drag(6, 92 - 13, 7, 92 - 12, "pen");
		await settle();
		expect(r.group("g1")).toEqual(old);
		expect(steps(r.sent)).toHaveLength(0);
	});

	it("a drop below the note's text keeps the old hook and moves no ink", async () => {
		const r = pinRig("pin-drop-none.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const old = r.group("g1");
		r.drag(6, 92 - 13, 150, 40 * 41, "pen");
		await settle();
		expect(r.group("g1")).toEqual(old);
		expect(steps(r.sent)).toHaveLength(0);
	});
});

describe("the pin through the pen path", () => {
	it("a mouse down through the pen path on an unselected held group's pin, nothing selected, works the pin: the drag moves the hook and starts no ink", async () => {
		const r = pinRig("pin-path-mouse-held.md", { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const pin = r.pins()[0]!, p = penPath(r);
		expect(r.selected(), "nothing selected").toEqual([]);
		p.down(pin.at.x, pin.at.y - 13, "mouse");
		expect([p.o.mode, p.o.pinPress !== null], "[mode, pin press]").toEqual(["lasso", true]);
		p.move(140, 300);
		p.move(150, 380);
		p.up({ type: "pointerup", pointerType: "mouse" });
		await settle();
		expect(r.group("g1").target).toMatchObject(wordOn(10, 8, "words"));
		expect(p.wetDowns, "no ink stroke began").toEqual([]);
	});

	it("a pointercancel after the pin moved past the pad puts it back: the hook and the saved record stay, nothing is written", async () => {
		const r = pinRig("pin-path-cancel.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const p = penPath(r), old = r.group("g1");
		const saved = JSON.stringify(inlineInk.attachments(r.path));
		p.down(6, 92 - 13, "pen");
		p.move(80, 200);
		p.move(150, 380);
		expect((p.o.pinPress as { moved?: boolean } | null)?.moved, "the pin moved past the pad").toBe(true);
		p.up({ type: "pointercancel", pointerType: "pen" });
		await settle();
		expect(r.group("g1"), "the hook stays on its words").toEqual(old);
		expect(JSON.stringify(inlineInk.attachments(r.path)), "the saved record is unchanged").toBe(saved);
		expect(steps(r.sent), "nothing written").toHaveLength(0);
		expect(p.o.pinPress, "no press left behind").toBeNull();
	});

	it("a window blur after the pin moved (a lift with no event) puts it back the same way", async () => {
		const r = pinRig("pin-path-blur.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const p = penPath(r), old = r.group("g1");
		p.down(6, 92 - 13, "pen");
		p.move(80, 200);
		p.move(150, 380);
		p.up();
		await settle();
		expect(r.group("g1"), "the hook stays on its words").toEqual(old);
		expect(steps(r.sent), "nothing written").toHaveLength(0);
	});

	it("CONTROL: the same pen drag lifted with a pointerup moves the hook", async () => {
		const r = pinRig("pin-path-lift.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const p = penPath(r);
		p.down(6, 92 - 13, "pen");
		p.move(80, 200);
		p.move(150, 380);
		p.up({ type: "pointerup", pointerType: "pen" });
		await settle();
		expect(r.group("g1").target).toMatchObject(wordOn(10, 8, "words"));
		expect(steps(r.sent), "one step").toHaveLength(1);
	});
});

describe("the Attach button through the pen path: a cancel does nothing", () => {
	/** The button's centre, world units (zoom 1 in this rig). */
	const buttonOf = (r: ReturnType<typeof pinRig>) =>
		attachButtonPoint((r.overlay as unknown as { selectionBounds(): Bounds }).selectionBounds()!, 1, 1);
	const ids = (r: ReturnType<typeof pinRig>) => inlineInk.attachments(r.path).map((a) => a.id);

	it("a pen down on the button, then a pointercancel: no detach, the saved record is unchanged, nothing is written", async () => {
		const r = pinRig("button-path-cancel.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const p = penPath(r), b = buttonOf(r);
		const before = ids(r), saved = JSON.stringify(inlineInk.attachments(r.path));
		p.down(b.x, b.y, "pen");
		expect(p.o.mode, "the tip went to the lasso").toBe("lasso");
		p.move(b.x + 2, b.y + 1);
		p.up({ type: "pointercancel", pointerType: "pen" });
		await settle();
		expect(ids(r), "the attach list is the same").toEqual(before);
		expect(JSON.stringify(inlineInk.attachments(r.path)), "the saved record is unchanged").toBe(saved);
		expect(steps(r.sent), "nothing written").toHaveLength(0);
	});

	it("a pen down on the button, then a window blur (a lift with no event): no detach, nothing is written", async () => {
		const r = pinRig("button-path-blur.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const p = penPath(r), b = buttonOf(r);
		const before = ids(r), saved = JSON.stringify(inlineInk.attachments(r.path));
		p.down(b.x, b.y, "pen");
		p.move(b.x + 2, b.y + 1);
		p.up();
		await settle();
		expect(ids(r), "the attach list is the same").toEqual(before);
		expect(JSON.stringify(inlineInk.attachments(r.path)), "the saved record is unchanged").toBe(saved);
		expect(steps(r.sent), "nothing written").toHaveLength(0);
	});

	it("CONTROL: the same pen tap lifted with a pointerup detaches g1", async () => {
		const r = pinRig("button-path-lift.md");
		r.selection.selectExactly(G1);
		r.redraw();
		const p = penPath(r), b = buttonOf(r);
		expect(ids(r), "g1 is attached before").toContain("g1");
		p.down(b.x, b.y, "pen");
		p.move(b.x + 2, b.y + 1);
		p.up({ type: "pointerup", pointerType: "pen" });
		await settle();
		expect(ids(r), "g1 detached").not.toContain("g1");
	});
});

describe("who works the pin", () => {
	it("a finger tap on an unselected held group's pin selects the group and is kept from the text", () => {
		const r = pinRig("pin-finger-tap.md", { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const pin = r.pins()[0]!;
		const answer = r.tapAt(pin.at.x, pin.at.y - 13);
		expect([answer, r.selected()]).toEqual([true, G1]);
	});

	it("CONTROL: a pen on an unselected held group's pin is not taken by the pin: the lasso starts a loop there", () => {
		// The nib always inks: penDown never sends a bare tip to lassoDown with nothing selected, and a pen lasso
		// contact on the pin loops, as anywhere else with nothing selected.
		const r = pinRig("pin-pen-held.md", { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const pin = r.pins()[0]!;
		r.o.lassoDown(r.sample(pin.at.x, pin.at.y - 13), "pen");
		expect((r.overlay as unknown as { lassoActive: boolean }).lassoActive, "a loop began").toBe(true);
		expect(r.selected()).toEqual([]);
	});

	it("a mouse press on an unselected held group's pin selects its group, and a lift there changes nothing", () => {
		const r = pinRig("pin-mouse-held-select.md", { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const pin = r.pins()[0]!, old = r.group("g1");
		r.o.lassoDown(r.sample(pin.at.x, pin.at.y - 13), "mouse");
		expect(r.selected(), "the press selects the held group").toEqual(G1);
		r.o.lassoUp();
		expect(r.selected(), "still selected after the lift").toEqual(G1);
		expect(r.group("g1")).toEqual(old);
		expect(steps(r.sent)).toHaveLength(0);
	});

	it("SHOWN offset premise: g1 shows 6 right and 12 down of its stored points", () => {
		expect(SHOWN).toEqual({ dx: 6, dy: 12 });
	});
});
