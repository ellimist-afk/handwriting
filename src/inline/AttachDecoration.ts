import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { BBox, InkStroke } from "../ink/Stroke";
import type { CameraState } from "../camera/coordinates";
import { isOpaqueAttachment, type AttachmentData } from "./InkAttachments";
import { Notice } from "obsidian";
import { drawPin, drawTagPill, PIN_HEAD_PX, PIN_LIFT_PX } from "../ink/TailRenderer";

export { PIN_HEAD_PX, PIN_LIFT_PX };
import type { Point2 } from "../ink/Smoothing";
import { HANDLE_TOUCH_PX, type HandleInput } from "./LassoTransform";

/**
 * Attached ink on screen: the strip's Attach and Detach states, the outline round a selected group, the "Attached" label
 * and the tag on a group that needs reattachment, the link icon on every group that follows its text and is
 * not selected, the pin that moves a group's hook, the finger tap that selects a group, and the mark on the selected
 * group's text. All of it is chrome on the canvases or
 * a mark in the editor: nothing here moves ink or writes the page. A camera move redraws it from boxes kept per member
 * map and the camera snapshot, never from a layout read.
 */

/**
 * EVERY USER-FACING STRING ATTACHED INK SHOWS, IN ONE PLACE. Drafts: Alan edits each one before it ships. No other
 * file writes these words; the strip's button labels and the toast read them from here.
 */
export const ATTACH_STRINGS = {
	/** The Attach button's hover words. The same button detaches. */
	button: "Attach",
	/** The label on the one selected group, a word group or a paragraph group alike: the mark on its text shows which text. */
	attached: "Attached",
	/** The tag on a group that needs reattachment, beside its pin. Alan's placeholder; his later words replace it here. */
	needs: "Drag the pin to the text",
	noText: "No text under the ink",
} as const;

/** What Attach and Detach may do, as attachmentSelection answers it, from the follow's kept stroke-to-group map. */
export interface ChipState {
	attach: boolean;
	detach: boolean;
	/** The groups the selection touches, in selection order. */
	groupIds: string[];
}

/**
 * The chip states for a selection, from the stroke-to-group map the follow already keeps (no map built per call).
 * Attach: something selected and at most one group touched. Detach: one group touched and every selected stroke in
 * it, or two groups or more, loose ink in the lasso or not (one tap detaches each group touched).
 */
export function chipState(memberMap: ReadonlyMap<string, string>, ids: readonly string[]): ChipState {
	const groupIds: string[] = [];
	let allMembers = true;
	for (const id of ids) {
		const g = memberMap.get(id);
		if (g === undefined) { allMembers = false; continue; }
		if (!groupIds.includes(g)) groupIds.push(g);
	}
	return {
		attach: ids.length > 0 && groupIds.length <= 1,
		detach: groupIds.length > 1 || (groupIds.length === 1 && allMembers),
		groupIds,
	};
}

/** One group's box where this surface shows it, and whether it needs reattachment. */
export interface GroupBox {
	id: string;
	box: BBox;
	needs: boolean;
	/** A record this build cannot read (InkAttachments isOpaqueAttachment): it keeps its tag and has no pin. */
	opaque?: true;
}

type Offset = { dx: number; dy: number } | null;

/**
 * Each members map's stored unions, by group id, each built the first time a redraw asks for it: freeFor gives a new
 * map whenever ink or membership changes, and a redraw with nothing selected asks only for the held groups'.
 */
const storedUnions = new WeakMap<object, Map<string, BBox | null>>();

function unionOf(strokes: readonly InkStroke[]): BBox | null {
	let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
	for (const s of strokes) {
		const b = s.bbox;
		if (b.x < x) x = b.x;
		if (b.y < y) y = b.y;
		if (b.x + b.width > right) right = b.x + b.width;
		if (b.y + b.height > bottom) bottom = b.y + b.height;
	}
	return right >= x && bottom >= y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Every group's shown box: the union of its members' stored boxes, kept per members map, moved by the group's
 * correction. A pending group (no correction yet) is left out, as it is not painted. An opaque record's members are
 * read from its raw strokeIds when it has them; it always needs reattachment.
 */
export function groupBoxes(
	list: readonly AttachmentData[],
	members: ReadonlyMap<string, readonly InkStroke[]>,
	offsetOf: (id: string) => Offset,
	followsText: (id: string) => boolean,
	strokeById: (id: string) => InkStroke | undefined,
): GroupBox[] {
	if (list.length === 0) return [];
	let stored = storedUnions.get(members);
	if (!stored) storedUnions.set(members, (stored = new Map<string, BBox | null>()));
	const kept = stored;
	const storedOf = (id: string): BBox | null | undefined => {
		if (kept.has(id)) return kept.get(id);
		const ms = members.get(id), u = ms ? unionOf(ms) : null;
		kept.set(id, u);
		return u;
	};
	const out: GroupBox[] = [];
	for (const a of list) {
		if (isOpaqueAttachment(a)) {
			const raw = a.raw["strokeIds"];
			if (!Array.isArray(raw)) continue;
			const ms = raw.flatMap((id) => {
				const s = typeof id === "string" ? strokeById(id) : undefined;
				return s ? [s] : [];
			});
			const u = unionOf(ms);
			if (u) out.push({ id: a.id, box: u, needs: true, opaque: true });
			continue;
		}
		const b = storedOf(a.id), o = offsetOf(a.id);
		if (!b || !o) continue;
		const box = o.dx === 0 && o.dy === 0 ? b : { x: b.x + o.dx, y: b.y + o.dy, width: b.width, height: b.height };
		out.push({ id: a.id, box, needs: !followsText(a.id) });
	}
	return out;
}

/**
 * What the committed layer shows over a group with nothing drawn on the tail for it: the "Needs reattachment" tag on a
 * held group, the link icon on a group that follows its text and is not selected. `id` is the group's.
 */
export interface AttachMark {
	id: string;
	box: BBox;
	kind: "needs" | "icon";
	/** A record this build cannot read: its tag shows with no pin. */
	opaque?: true;
}

/**
 * The marks for these boxes: the tag on every group that needs reattachment, selected or not; the link icon on every
 * other group that is not selected. A selected group shows today's chrome instead, and a held one its tag, never an icon.
 */
export function attachMarks(boxes: readonly GroupBox[], selectedGroupIds: readonly string[]): AttachMark[] {
	const out: AttachMark[] = [];
	for (const g of boxes) {
		if (g.needs) out.push({ id: g.id, box: g.box, kind: "needs", ...(g.opaque ? { opaque: true as const } : {}) });
		else if (!selectedGroupIds.includes(g.id)) out.push({ id: g.id, box: g.box, kind: "icon" });
	}
	return out;
}

/** The link icon's side, css px, at every zoom. */
export const LINK_ICON_PX = 12;
/** How far the icon sits clear of its group's box, css px, up and left of its top-left corner. */
export const LINK_ICON_GAP_PX = 3;
/** How far past the icon a finger tap still takes it, css px, on every side. */
export const LINK_ICON_TOUCH_PAD_PX = 8;

/** The world rect the link icon covers at this zoom: LINK_ICON_PX square, LINK_ICON_GAP_PX up and left of the box's corner. */
export function linkIconRect(box: BBox, zoom: number, cssScale: number): BBox {
	const k = 1 / (zoom * cssScale), off = (LINK_ICON_GAP_PX + LINK_ICON_PX) * k;
	return { x: box.x - off, y: box.y - off, width: LINK_ICON_PX * k, height: LINK_ICON_PX * k };
}

/**
 * The link icon at a box's top-left, outside it: two rings, the Attach button's link mark, in `color`, LINK_ICON_PX css
 * px across whatever the zoom. World-anchored, so a camera move redraws it from the box and the camera alone.
 */
export function drawLinkIcon(ctx: CanvasRenderingContext2D, cam: CameraState, box: BBox, color: string, cssScale: number): void {
	const off = LINK_ICON_GAP_PX + LINK_ICON_PX, c = LINK_ICON_PX / 2;
	ctx.save();
	ctx.translate((box.x - cam.x) * cam.zoom, (box.y - cam.y) * cam.zoom);
	ctx.scale(1 / cssScale, 1 / cssScale);
	ctx.setLineDash([]);
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.5;
	for (const dx of [-2.5, 2.5]) {
		ctx.beginPath();
		ctx.arc(c - off + dx, c - off, 3.25, 0, Math.PI * 2);
		ctx.stroke();
	}
	ctx.restore();
}

/** One label drawn at a box's top-left. */
export interface ChromeLabel {
	box: BBox;
	text: string;
	needs: boolean;
}

/** The chrome for one redraw: an outline per selected group and the labels, and the selected group's pin when it has one. */
export interface AttachChrome {
	outlines: BBox[];
	labels: ChromeLabel[];
	/** The one selected group's pin on its words; a held group's pin is the committed layer's (paintHeldTags). */
	pins?: AttachPin[];
}

/**
 * A pin: the handle that moves a group's hook to other words. `at` is its point, world units: on a group that follows its
 * text, the start of its words (the record's reference point moved by the group's correction, so no layout read); on a
 * group that needs reattachment, just left of its tag. The head sits PIN_LIFT_PX above the point.
 */
export interface AttachPin {
	id: string;
	at: Point2;
	held: boolean;
}

/** A pen's or a mouse's hit square on the pin's head, css px. A finger's is HANDLE_TOUCH_PX. */
export const PIN_POINTER_PX = 20;
/** A held group's pin point, css px left of and above its box's top-left: just left of its tag. */
const PIN_HELD_DX_PX = 14, PIN_HELD_DY_PX = 8;

/** The pin's head centre, world units, at this zoom. */
export function pinHead(at: Point2, zoom: number, cssScale: number): Point2 {
	return { x: at.x, y: at.y - PIN_LIFT_PX / (zoom * cssScale) };
}

/** Whether world `w` is on the pin's head: a square of the input's hit size round it. */
export function hitPin(at: Point2, zoom: number, w: Point2, input: HandleInput, cssScale: number): boolean {
	const half = (input === "touch" ? HANDLE_TOUCH_PX : PIN_POINTER_PX) / 2 / (zoom * cssScale), h = pinHead(at, zoom, cssScale);
	return Math.abs(w.x - h.x) <= half && Math.abs(w.y - h.y) <= half;
}

/** A held group's pin point for its box, at this zoom. */
function heldPinPoint(box: BBox, zoom: number, cssScale: number): Point2 {
	const k = 1 / (zoom * cssScale);
	return { x: box.x - PIN_HELD_DX_PX * k, y: box.y - PIN_HELD_DY_PX * k };
}

/** The world rect a pin may cover at this zoom: its head and stem with a css px round them. */
function pinRect(at: Point2, zoom: number, cssScale: number): BBox {
	const k = 1 / (zoom * cssScale), r = PIN_HEAD_PX / 2 + 1;
	return { x: at.x - r * k, y: at.y - (PIN_LIFT_PX + r) * k, width: 2 * r * k, height: (PIN_LIFT_PX + r + 1) * k };
}

export const NO_CHROME: AttachChrome = { outlines: [], labels: [] };

/**
 * What to draw: each selected group's outline (its union). One group selected: "Attached" at its top-left, on a word group
 * and on a paragraph group alike (the mark on its text shows the words or the whole paragraph).
 * Two or more: each one's outline and no label, whether the selection rests or is dragged, resized or turned. Every group
 * that needs reattachment carries the tag, selected or not; a selected one carries the tag instead of "Attached".
 */
export function attachChrome(boxes: readonly GroupBox[], selectedGroupIds: readonly string[]): AttachChrome {
	if (boxes.length === 0) return NO_CHROME;
	const outlines: BBox[] = [], labels: ChromeLabel[] = [];
	const selected = boxes.filter((g) => selectedGroupIds.includes(g.id));
	for (const g of selected) outlines.push(g.box);
	if (selected.length === 1 && !selected[0]!.needs) {
		const g = selected[0]!;
		labels.push({ box: g.box, text: ATTACH_STRINGS.attached, needs: false });
	}
	for (const g of boxes) if (g.needs) labels.push({ box: g.box, text: ATTACH_STRINGS.needs, needs: true });
	if (outlines.length === 0 && labels.length === 0) return NO_CHROME;
	return { outlines, labels };
}

/**
 * The group a tap at world (x, y) lands in, among `ids`: the one whose box, padded by `pad`, holds the point; the
 * smallest when boxes overlap. Null when none does.
 */
export function groupAt(boxes: readonly GroupBox[], ids: readonly string[], x: number, y: number, pad: number): string | null {
	let best: GroupBox | null = null, bestArea = Infinity;
	for (const g of boxes) {
		if (!ids.includes(g.id)) continue;
		const b = g.box;
		if (x < b.x - pad || x > b.x + b.width + pad || y < b.y - pad || y > b.y + b.height + pad) continue;
		const area = b.width * b.height;
		if (area < bestArea) { best = g; bestArea = area; }
	}
	return best?.id ?? null;
}

/** The tail calls the chrome draws through: the selection box's own dashed rect, one label, and one pin. */
export interface ChromeTail {
	drawSelectionBox(cam: CameraState, box: BBox, color: string): void;
	drawGroupTag(cam: CameraState, box: BBox, label: string, color: string, background: string, cssScale: number): void;
	drawAttachPin(cam: CameraState, at: Point2, color: string, background: string, cssScale: number): void;
}

/** The label colours, from the theme's CSS variables. */
export interface ChromeColours {
	text: string;
	needs: string;
	background: string;
	/** The Attach button's fill on a loose selection (--text-muted). */
	muted: string;
}

/** Read once per overlay: getPropertyValue is a style read, never a layout read, and never per frame. */
export function themeColours(el: Element | null): ChromeColours {
	const fallback = { text: "#dcddde", needs: "#fb464c", background: "#1e1e1e", muted: "#999999" };
	if (!el || typeof getComputedStyle !== "function") return fallback;
	const css = getComputedStyle(el), v = (name: string, or: string) => css.getPropertyValue(name).trim() || or;
	return {
		text: v("--text-normal", fallback.text),
		needs: v("--text-error", fallback.needs),
		background: v("--background-primary", fallback.background),
		muted: v("--text-muted", fallback.muted),
	};
}

/** Draw the chrome on the tail: outlines in the selection colour, labels in the theme's. */
export function drawAttachChrome(tail: ChromeTail, cam: CameraState, chrome: AttachChrome, outline: string, colours: ChromeColours, cssScale: number): void {
	for (const box of chrome.outlines) tail.drawSelectionBox(cam, box, outline);
	for (const l of chrome.labels) tail.drawGroupTag(cam, l.box, l.text, l.needs ? colours.needs : colours.text, colours.background, cssScale);
	for (const p of chrome.pins ?? []) tail.drawAttachPin(cam, p.at, outline, colours.background, cssScale);
}

/** The selected group's text, or none. */
export const setAttachTarget = StateEffect.define<{ from: number; to: number } | null>({
	map: (v, changes) => (v ? { from: changes.mapPos(v.from, 1), to: changes.mapPos(v.to, -1) } : null),
});

const targetMark = Decoration.mark({ class: "hw-attach-target" });

/** The mark on the selected group's text: set by setAttachTarget, mapped through edits, none by default. */
export const attachTargetField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const e of tr.effects) {
			if (!e.is(setAttachTarget)) continue;
			const v = e.value, len = tr.state.doc.length;
			deco = v && v.to > v.from && v.from >= 0 && v.to <= len ? Decoration.set([targetMark.range(v.from, v.to)]) : Decoration.none;
		}
		return deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

export function attachTargetExtension(): Extension {
	return attachTargetField;
}

/** What the strip and the chrome read off an overlay: its note, its follow and its selection. */
export interface AttachSurface {
	filePath(): string | null;
	readonly lineAnchors: { readonly follow: { setList(list: readonly AttachmentData[]): void; readonly memberMap: ReadonlyMap<string, string> } };
	readonly selection: { readonly strokeIds: string[]; readonly revision: number; readonly isEmpty: boolean };
}

const keptChips = new WeakMap<object, { rev: number; map: ReadonlyMap<string, string>; state: ChipState }>();
const NO_CHIPS: ChipState = { attach: false, detach: false, groupIds: [] };

/**
 * The selection's chip state on this overlay, kept while the selection and the membership hold: the strip asks on
 * every refresh, the chrome on every redraw.
 */
export function selectionChips(surface: AttachSurface, list: readonly AttachmentData[]): ChipState {
	const sel = surface.selection;
	if (sel.isEmpty || !surface.filePath()) return NO_CHIPS;
	const follow = surface.lineAnchors.follow;
	follow.setList(list);
	const map = follow.memberMap, kept = keptChips.get(surface);
	if (kept && kept.rev === sel.revision && kept.map === map) return kept.state;
	const state = chipState(map, sel.strokeIds);
	keptChips.set(surface, { rev: sel.revision, map, state });
	return state;
}

/** What the redraw reads off the overlay beyond the strip's surface: the note's ink, the anchors' member lists, the view. */
export interface ChromeOverlay extends AttachSurface {
	readonly lineAnchors: AttachSurface["lineAnchors"] & {
		readonly follow: AttachSurface["lineAnchors"]["follow"] & {
			groupOffset(id: string): Offset;
			followsText(id: string): boolean;
			/** Bumped on every correction change: a group's shown place moved. */
			readonly generation?: number;
		};
		freeFor(path: string, src: readonly InkStroke[]): { members: ReadonlyMap<string, readonly InkStroke[]> };
	};
	readonly view: EditorView;
	readonly camera: { readonly snapshot: CameraState };
	readonly cssScale: number;
	readonly damage: { addRect(r: BBox): void };
	refreshStrip(): void;
	scheduleRepaint(kind: "partial"): void;
}

/**
 * Per overlay: the theme's colours (read once), the chip state the strip last showed, the target last marked, and the
 * marks the committed layer shows, tags and link icons (with their key, so an unchanged set costs one compare).
 */
const overlayKept = new WeakMap<object, OverlayKept>();
interface OverlayKept {
	colours?: ChromeColours;
	chips?: ChipState;
	target?: string;
	tags?: readonly AttachMark[];
	tagKey?: string;
	/** The marks need working out again: the next committed repaint does it (refreshHeldTags). */
	tagsStale?: boolean;
	/**
	 * What the marks were last checked against with nothing selected: the held ids, the following ids, the list, the
	 * stroke list and its generation, the follow's generation and the selection's revision.
	 */
	held?: { ids: string; icons: string; list: readonly AttachmentData[]; strokes: readonly InkStroke[]; gen: number; fgen: number; rev: number };
	/** What the committed repaint's check last saw with nothing selected (staleTagsOnPaint). */
	painted?: { list: readonly AttachmentData[]; strokes: readonly InkStroke[]; gen: number; fgen: number; rev: number };
}
/**
 * Each stroke list's ids, built only for an opaque record's members, kept with the list's generation: the store changes a
 * list in place (a stroke pushed, swapped or removed) and bumps the generation at each such change, so the same list object
 * at a new generation is read again.
 */
const idsOf = new WeakMap<readonly InkStroke[], { gen: number; map: Map<string, InkStroke> }>();

/**
 * The chrome for this redraw. No groups: NO_CHROME after one list read. Otherwise boxes kept per members map, the
 * selection's groups kept per selection revision: no walk of the note, no layout read.
 */
export function attachChromeOf(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], gen: number): AttachChrome {
	const path = o.filePath();
	if (!path) return NO_CHROME;
	if (list.length === 0) {
		// The last group just went (a Detach): clear its mark and refresh the strip once; a note that never had a
		// group reads nothing more.
		if (overlayKept.get(o)?.chips) syncAfterRedraw(o, list, selectionChips(o, list));
		keepTags(o, []);
		return NO_CHROME;
	}
	const anchors = o.lineAnchors, follow = anchors.follow;
	follow.setList(list);
	const byId = strokeByIdIn(strokes, gen);
	const chips = selectionChips(o, list);
	// Every group carries a mark (a tag or the link icon), so every group's box is read: kept per members map.
	const boxes = groupBoxes(list, anchors.freeFor(path, strokes).members, (id) => follow.groupOffset(id), (id) => follow.followsText(id), byId);
	syncAfterRedraw(o, list, chips);
	keepTags(o, attachMarks(boxes, chips.groupIds));
	const chrome = attachChrome(boxes, chips.groupIds), pin = selectedPin(o, list, boxes, chips);
	return pin ? { ...chrome, pins: [pin] } : chrome;
}

/** The one selected group's pin on its words, when one group that follows its text is selected; else null. */
function selectedPin(o: ChromeOverlay, list: readonly AttachmentData[], boxes: readonly GroupBox[], chips: ChipState): AttachPin | null {
	if (chips.groupIds.length !== 1) return null;
	const id = chips.groupIds[0]!, g = boxes.find((b) => b.id === id);
	if (!g || g.needs) return null;
	const a = list.find((x) => x.id === id), off = o.lineAnchors.follow.groupOffset(id);
	if (!a || isOpaqueAttachment(a) || !off) return null;
	return { id, at: { x: a.ref.x + off.dx, y: a.ref.y + off.dy }, held: false };
}

/**
 * Every pin shown now: the one selected group's on its words, and every held group's beside its tag, selected or not.
 * Boxes kept per members map (groupBoxes): no walk of the note, no layout read. What the pin's hit test reads.
 */
export function attachPinsOf(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], gen: number): AttachPin[] {
	const path = o.filePath();
	if (!path || list.length === 0) return [];
	const follow = o.lineAnchors.follow;
	follow.setList(list);
	const chips = selectionChips(o, list), zoom = o.camera.snapshot.zoom;
	const boxes = groupBoxes(list, o.lineAnchors.freeFor(path, strokes).members, (id) => follow.groupOffset(id), (id) => follow.followsText(id), strokeByIdIn(strokes, gen));
	const out: AttachPin[] = [];
	const sel = selectedPin(o, list, boxes, chips);
	if (sel) out.push(sel);
	for (const g of boxes) if (g.needs && !g.opaque) out.push({ id: g.id, at: heldPinPoint(g.box, zoom, o.cssScale), held: true });
	return out;
}

/** A stroke by id in this list: the id map built only for an opaque record's members, kept per list and generation. */
function strokeByIdIn(strokes: readonly InkStroke[], gen: number): (id: string) => InkStroke | undefined {
	return (id) => {
		let k = idsOf.get(strokes);
		if (!k || k.gen !== gen) idsOf.set(strokes, (k = { gen, map: new Map(strokes.map((s) => [s.id, s] as const)) }));
		return k.map.get(id);
	};
}

/** Whether a group shows a tag: an opaque record always, any other while it does not follow its text. */
function isHeld(follow: ChromeOverlay["lineAnchors"]["follow"], a: AttachmentData): boolean {
	return isOpaqueAttachment(a) || !follow.followsText(a.id);
}

/**
 * The redraw with nothing selected, no lasso and no preview: the chip and mark sync, and no group boxes (no member
 * lists, no unions). When the held or following groups, the list, the corrections, the selection or the stroke list
 * changed since the last check, the marks go stale; the next committed repaint works them out (refreshHeldTags), so a
 * moved tag or icon lands in the same frame as its moved ink. A partial repaint is asked for every change but a stroke
 * list change under icons alone: the store change that made the new list asks its own. A note that never had a group
 * reads nothing more than the list.
 */
export function syncWithoutChrome(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], gen: number): void {
	if (!o.filePath()) return;
	const kept = overlayKept.get(o);
	if (list.length === 0 && !kept) return;
	if (list.length > 0 || kept?.chips) syncAfterRedraw(o, list, selectionChips(o, list));
	const k = overlayKept.get(o) ?? (overlayKept.set(o, {}), overlayKept.get(o)!);
	const follow = o.lineAnchors.follow;
	follow.setList(list);
	let ids = "", icons = "";
	for (const a of list) {
		if (isHeld(follow, a)) ids += a.id + ";";
		else icons += a.id + ";";
	}
	const h = k.held, fgen = follow.generation ?? 0, rev = o.selection.revision;
	const sameMarks = !!h && h.ids === ids && h.icons === icons && h.list === list && h.fgen === fgen && h.rev === rev;
	if (sameMarks && h.strokes === strokes && h.gen === gen) return;
	k.held = { ids, icons, list, strokes, gen, fgen, rev };
	// No group now and no mark shown: nothing to work out.
	if (ids === "" && icons === "" && !(k.tags && k.tags.length > 0)) return;
	k.tagsStale = true;
	if (!sameMarks || ids !== "") o.scheduleRepaint("partial");
}

/**
 * At the top of a committed repaint with nothing selected, before the stale flag is read: the marks (held tags, link icons)
 * go stale when the list, the stroke list or its generation, the follow's generation or the selection's revision moved
 * since this check last saw them. Opening a note and typing reach no redraw, so without this a group's icon or tag would
 * not show at open, nor follow its ink, until the next select. Identity and number compares only: no list walk, no string
 * built, no DOM or layout read. No repaint asked: refreshHeldTags adds the old and new rects to this paint, so a mark
 * moves in the same frame as its ink. A note with no group and no mark shown keeps nothing.
 */
export function staleTagsOnPaint(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], gen: number): void {
	const kept = overlayKept.get(o);
	if (list.length === 0 && !(kept?.tags && kept.tags.length > 0)) return;
	const fgen = o.lineAnchors.follow.generation ?? 0, rev = o.selection.revision, seen = kept?.painted;
	if (seen && seen.list === list && seen.strokes === strokes && seen.gen === gen && seen.fgen === fgen && seen.rev === rev) return;
	const k = kept ?? (overlayKept.set(o, {}), overlayKept.get(o)!);
	k.painted = { list, strokes, gen, fgen, rev };
	k.tagsStale = true;
}

/** Whether a redraw left this overlay's held tags for the next committed repaint to work out. */
export function heldTagsStale(o: object): boolean {
	return overlayKept.get(o)?.tagsStale === true;
}

/**
 * At the top of a committed repaint, before its rects paint: the marks (held tags, link icons) worked out again when a
 * redraw left them stale, from the member lists the repaint's free list has just read. A partial repaint gets the old and
 * the new mark rects added to its work; a whole one paints every mark in view anyway. Returns the work to paint.
 */
export function refreshHeldTags(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], gen: number, zoom: number, work: "all" | BBox[]): "all" | BBox[] {
	const kept = overlayKept.get(o), path = o.filePath();
	if (!kept?.tagsStale || !path) return work;
	kept.tagsStale = false;
	const follow = o.lineAnchors.follow;
	follow.setList(list);
	const tags = list.length === 0 ? [] : attachMarks(
		groupBoxes(list, o.lineAnchors.freeFor(path, strokes).members, (id) => follow.groupOffset(id), (id) => follow.followsText(id), strokeByIdIn(strokes, gen)),
		selectionChips(o, list).groupIds,
	);
	const key = marksKey(tags);
	if (key === (kept.tagKey ?? "")) return work;
	const old = kept.tags ?? [];
	kept.tags = tags;
	kept.tagKey = key;
	return work === "all" ? work : [...work, ...[...old, ...tags].map((m) => markRect(m, zoom, o.cssScale))];
}

/** One compare for an unchanged set of marks: each one's kind, group and box corner. */
function marksKey(marks: readonly AttachMark[]): string {
	return marks.map((m) => `${m.kind} ${m.id} ${m.box.x},${m.box.y}`).join(";");
}

/** The world rect a mark may cover at this zoom: the tag's pill, or the link icon with one css px round it. */
function markRect(m: AttachMark, zoom: number, cssScale: number): BBox {
	if (m.kind === "needs") {
		const t = tagRect(m.box, zoom, cssScale);
		if (m.opaque) return t;
		const p = pinRect(heldPinPoint(m.box, zoom, cssScale), zoom, cssScale), x = Math.min(t.x, p.x), y = Math.min(t.y, p.y);
		return { x, y, width: Math.max(t.x + t.width, p.x + p.width) - x, height: Math.max(t.y + t.height, p.y + p.height) - y };
	}
	const r = linkIconRect(m.box, zoom, cssScale), k = 1 / (zoom * cssScale);
	return { x: r.x - k, y: r.y - k, width: r.width + 2 * k, height: r.height + 2 * k };
}

/**
 * The world rect a tag's pill may cover at this zoom: 7 css px left of the box and 25 above it, 9 css px a character
 * wide, a bound on what drawTagPill paints.
 */
function tagRect(box: BBox, zoom: number, cssScale: number): BBox {
	const k = 1 / (zoom * cssScale);
	return { x: box.x - 7 * k, y: box.y - 25 * k, width: (ATTACH_STRINGS.needs.length * 9 + 16) * k, height: 20 * k };
}

/**
 * The marks the committed layer shows. When the set changes (a group turns held or resolves, moves, goes, or is selected
 * or let go), the old and new marks' rects are damaged and a partial repaint asked: the tail never needs its full size for them.
 */
function keepTags(o: ChromeOverlay, tags: readonly AttachMark[]): void {
	let kept = overlayKept.get(o);
	if (!kept) overlayKept.set(o, (kept = {}));
	const key = marksKey(tags);
	if (key === (kept.tagKey ?? "")) return;
	const zoom = o.camera.snapshot.zoom;
	for (const m of [...(kept.tags ?? []), ...tags]) o.damage.addRect(markRect(m, zoom, o.cssScale));
	kept.tags = tags;
	kept.tagKey = key;
	o.scheduleRepaint("partial");
}

/**
 * The committed layer's paint, after its rect paints: every mark in view (a held group's tag in the theme's error colour,
 * a following group's link icon in its muted text colour) when it painted whole, else the marks meeting a damage rect
 * (a rect paint clears under it). Nothing on a note with no group.
 */
export function paintHeldTags(o: ChromeOverlay, ctx: CanvasRenderingContext2D, cam: CameraState, work: "all" | readonly BBox[], viewW: number, viewH: number): void {
	const kept = overlayKept.get(o), tags = kept?.tags;
	if (!kept || !tags || tags.length === 0) return;
	const view = { x: cam.x, y: cam.y, width: viewW / cam.zoom, height: viewH / cam.zoom };
	const meets = (a: BBox, b: BBox) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
	const colours = (kept.colours ??= themeColours(o.view.dom));
	for (const m of tags) {
		const r = markRect(m, cam.zoom, o.cssScale);
		if (!meets(r, view) || (work !== "all" && !work.some((w) => meets(r, w)))) continue;
		if (m.kind === "needs") {
			drawTagPill(ctx, cam, m.box, ATTACH_STRINGS.needs, colours.needs, colours.background, o.cssScale);
			if (!m.opaque) drawPin(ctx, cam, heldPinPoint(m.box, cam.zoom, o.cssScale), colours.needs, colours.background, o.cssScale);
		} else drawLinkIcon(ctx, cam, m.box, colours.muted, o.cssScale);
	}
}

/** How many times a finger tap's lift scanned the attached ink: the cells read it, nothing ships on it. */
export const attachTapCounts = { scans: 0 };

/** The squared distance from (x, y) to a stroke's centre line, when it is within `r`; else Infinity. */
function lineDistSq(s: InkStroke, x: number, y: number, r: number): number {
	const b = s.bbox;
	if (x < b.x - r || x > b.x + b.width + r || y < b.y - r || y > b.y + b.height + r) return Infinity;
	const pts = s.points;
	let best = Infinity;
	if (pts.length === 1) best = (pts[0]!.x - x) ** 2 + (pts[0]!.y - y) ** 2;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!, c = pts[i]!, dx = c.x - a.x, dy = c.y - a.y, len = dx * dx + dy * dy;
		const t = len > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
		const d = (a.x + dx * t - x) ** 2 + (a.y + dy * t - y) ** 2;
		if (d < best) best = d;
	}
	return best <= r * r ? best : Infinity;
}

/**
 * The attached stroke a finger tap at world (x, y) lands on, or null. First the line: of every member stroke, each where
 * this surface shows it, the one whose centre line passes nearest the point within `reach` plus its half width. Then the
 * link icons the committed layer shows: the group whose icon, padded by LINK_ICON_TOUCH_PAD_PX, holds the point, the
 * smallest box when two do, answered by its first member. Free ink, the space between strokes (the word inside a circle)
 * and empty paper answer null. Read once, at the lift, from the member lists the anchors keep: no walk of the note.
 */
export function attachedStrokeAtTap(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], x: number, y: number, reach: number): string | null {
	const path = o.filePath();
	if (!path || list.length === 0) return null;
	attachTapCounts.scans++;
	const follow = o.lineAnchors.follow;
	follow.setList(list);
	const members = o.lineAnchors.freeFor(path, strokes).members;
	let best: string | null = null, bestEdge = Infinity;
	for (const [id, ms] of members) {
		const off = follow.groupOffset(id);
		if (!off) continue;
		const px = x - off.dx, py = y - off.dy;
		for (const s of ms) {
			const d = lineDistSq(s, px, py, reach + s.width / 2);
			if (d === Infinity) continue;
			const edge = Math.sqrt(d) - s.width / 2;
			if (edge < bestEdge) {
				bestEdge = edge;
				best = s.id;
			}
		}
	}
	if (best !== null) return best;
	const marks = overlayKept.get(o)?.tags;
	if (!marks || marks.length === 0) return null;
	const zoom = o.camera.snapshot.zoom, k = LINK_ICON_TOUCH_PAD_PX / (zoom * o.cssScale);
	let icon: AttachMark | null = null, area = Infinity;
	for (const m of marks) {
		if (m.kind !== "icon") continue;
		const r = linkIconRect(m.box, zoom, o.cssScale);
		if (x < r.x - k || x > r.x + r.width + k || y < r.y - k || y > r.y + r.height + k) continue;
		const a = m.box.width * m.box.height;
		if (a < area) {
			icon = m;
			area = a;
		}
	}
	return icon ? (members.get(icon.id)?.[0]?.id ?? null) : null;
}

/**
 * After the chrome is worked out: the strip refreshed when the chip state changed (an Attach, a Detach or an undo of
 * either changes it under a selection that did not), and the mark moved to the one selected group's text. Both are
 * deferred to a microtask: a redraw can run inside an update, where a dispatch throws.
 */
function syncAfterRedraw(o: ChromeOverlay, list: readonly AttachmentData[], chips: ChipState): void {
	let kept = overlayKept.get(o);
	if (!kept) overlayKept.set(o, (kept = {}));
	const one = chips.groupIds.length === 1 ? list.find((a) => a.id === chips.groupIds[0]) : undefined;
	const target = one && !isOpaqueAttachment(one) && o.lineAnchors.follow.followsText(one.id) ? one.target : null;
	const key = target ? `${target.from}:${target.to}` : "";
	const chipsChanged = kept.chips !== undefined && (kept.chips.attach !== chips.attach || kept.chips.detach !== chips.detach);
	kept.chips = chips;
	if (key === (kept.target ?? "") && !chipsChanged) return;
	const markChanged = key !== (kept.target ?? "");
	kept.target = key;
	const view = o.view;
	queueMicrotask(() => {
		if (chipsChanged) o.refreshStrip();
		if (markChanged && view.dom.isConnected) view.dispatch({ effects: setAttachTarget.of(target ? { from: target.from, to: target.to } : null) });
	});
}

/** Draw this redraw's chrome on the tail: the theme's colours read once per overlay. */
export function paintAttachChrome(o: ChromeOverlay, tail: ChromeTail, cam: CameraState, chrome: AttachChrome, outline: string, cssScale: number): void {
	if (chrome === NO_CHROME) return;
	let kept = overlayKept.get(o);
	if (!kept) overlayKept.set(o, (kept = {}));
	const colours = (kept.colours ??= themeColours(o.view.dom));
	drawAttachChrome(tail, cam, chrome, outline, colours, cssScale);
}

/**
 * A tap while two or more groups are selected: the members of the selected group whose union holds world (x, y),
 * the selection narrows to them. Null when fewer than two groups are selected or the tap is in none of them.
 */
export function narrowedTo(o: ChromeOverlay, list: readonly AttachmentData[], strokes: readonly InkStroke[], x: number, y: number, pad: number): string[] | null {
	const path = o.filePath();
	if (!path || list.length < 2) return null;
	const chips = selectionChips(o, list);
	if (chips.groupIds.length < 2) return null;
	const follow = o.lineAnchors.follow, members = o.lineAnchors.freeFor(path, strokes).members;
	const boxes = groupBoxes(list, members, (id) => follow.groupOffset(id), (id) => follow.followsText(id), () => undefined);
	const id = groupAt(boxes, chips.groupIds, x, y, pad);
	const ms = id === null ? undefined : members.get(id);
	return ms && ms.length > 0 ? ms.map((s) => s.id) : null;
}

/** The theme's colours on this overlay, read once (themeColours) and kept with the rest of its chrome. */
export function overlayColours(o: ChromeOverlay): ChromeColours {
	let kept = overlayKept.get(o);
	if (!kept) overlayKept.set(o, (kept = {}));
	return (kept.colours ??= themeColours(o.view.dom));
}

/** What the Attach button's tap runs: the same calls the palette commands make. */
export interface AttachToggleSurface extends AttachSurface {
	attachSelected(): boolean;
	detachSelected(): boolean;
}

/**
 * The Attach button's tap, one tap and no menu: with one whole attached group selected, or two groups or more, it
 * detaches each group touched; else, while the selection can attach, it attaches (no text under the ink says so and
 * attaches nothing). The same answers the palette commands read. What it did, or null when it did nothing.
 */
export function toggleAttach(o: AttachToggleSurface, list: readonly AttachmentData[]): "attached" | "detached" | null {
	const chips = selectionChips(o, list);
	if (chips.detach) return o.detachSelected() ? "detached" : null;
	if (!chips.attach) return null;
	if (o.attachSelected()) return "attached";
	new Notice(ATTACH_STRINGS.noText);
	return null;
}
