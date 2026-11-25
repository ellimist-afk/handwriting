/**
 * A move of ink on a note keeps, for each stroke it moves for the first time since the last save, the stroke as it stood
 * before: the merge after a read of the note's file (adoptSidecar) matches the other device's pieces of that stroke to it,
 * so a line both notes changed is drawn once. The version is kept as unsaved, then as handed to a save, then as put in the
 * file by a landed save, and each must still be the stroke as it stood after any later move, cut, reshape or undo of the
 * live stroke, and after the read's own rescale of the note's ink to the file's font size.
 *
 * A large move must not pay for that with a copy of every point it moves: an Insert Space release on a long note moves
 * every stroke below the gap at once, and the copy made that release about four times slower.
 *
 * Real InlineInkStore (the plugin's). The host hands every save to a list and lands one only when the cell says so; the
 * file is read through PageStore over FakeAdapter. A version's points are compared within 1e-9 in x and y: the merge
 * compares them within 0.02. Its createdAt, tool, colour, width and each point's pressure and time are compared exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { handedBefore, landedVersions, unsavedChanges } from "./InlineInkStoreCommit";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkPoint, InkStroke } from "../ink/Stroke";

const N = "Moved.md";
const PID = "moved-page";
const FILE = `.handwriting/${PID}.json`;
/** Within this a rebuilt x or y is the number it stood at. */
const EXACT = 1e-9;

/** A stroke of 101 samples at uneven, non-integer places, so a version that shares or drifts from the live points shows. */
function stroke(id: string, createdAt: number, x0 = 5.3, y0 = 100.37): InkStroke {
	const points: InkPoint[] = [];
	for (let i = 0; i <= 100; i++) points.push({ x: x0 + i * 2.07, y: y0 + (i % 5) * 0.13, pressure: 0.25 + (i % 3) * 0.25, t: i * 4 });
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	const bbox = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, width: Math.max(...xs) - Math.min(...xs) + 2, height: Math.max(...ys) - Math.min(...ys) + 2 };
	return { id, tool: "pen", color: "#1f2a44", width: 2, points, bbox, createdAt };
}

/** A deep copy: what the stroke is now, kept apart from it. */
function copyOf(s: InkStroke): InkStroke {
	return { ...s, points: s.points.map((p) => ({ ...p })), bbox: { ...s.bbox } };
}

/** A piece the eraser cut out of `s` as it stands: samples `from` to `to`, a new id. */
function pieceOf(s: InkStroke, id: string, from: number, to: number): InkStroke {
	return { ...copyOf(s), id, points: s.points.slice(from, to + 1).map((p) => ({ ...p })) };
}

/** The version is the stroke as it stood: exact in all but x and y, which are within EXACT. */
function expectStood(v: InkStroke | null | undefined, was: InkStroke, label: string): void {
	expect(v, `${label}: a version is kept`).toBeTruthy();
	const got = v!;
	expect([got.id, got.createdAt, got.tool, got.color, got.width], `${label}: id, createdAt, tool, colour and width as they stood`).toEqual([was.id, was.createdAt, was.tool, was.color, was.width]);
	const pts = got.points;
	expect(pts.length, `${label}: as many points as it stood with`).toBe(was.points.length);
	let worst = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i]!, b = was.points[i]!;
		worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
		if (a.pressure !== b.pressure || a.t !== b.t) expect([i, a.pressure, a.t], `${label}: point ${i}'s pressure and time as they stood`).toEqual([i, b.pressure, b.t]);
	}
	expect(worst, `${label}: the farthest point from where it stood`).toBeLessThanOrEqual(EXACT);
}

function rig(fileStrokes: readonly InkStroke[] = [stroke("S", 1)]) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const fileHolds = (strokes: readonly InkStroke[], fontRefPx?: number): void => {
		const page = emptyPage(PID);
		page.surface = "inline";
		page.strokes = strokes.map(copyOf);
		if (fontRefPx !== undefined) page.fontRefPx = fontRefPx;
		fake.files.set(FILE, serializePage(page));
	};
	fileHolds(fileStrokes);
	const handed: PageData[] = [];
	/** Each handed page as the save would write it, serialized when it was handed (its stroke list is the note's own). */
	const bytes: string[] = [];
	const landed = new Set<PageData>();
	const host: InlineInkHost = {
		readPageId: () => PID,
		claimId: async () => ({ pageId: PID }) as never,
		loadSidecar: (id) => store.load(id),
		scheduleSidecar: (_id, page) => {
			handed.push(page);
			bytes.push(serializePage(page));
		},
		sidecarLanded: (page) => landed.has(page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const rec = (): never => (inlineInk as unknown as { record(path: string): never }).record(N);
	const read = async (): Promise<readonly InkStroke[]> => {
		await (inlineInk as unknown as { adoptSidecar(rec: object, id: string): Promise<boolean> }).adoptSidecar(rec(), PID);
		return inlineInk.strokes(N);
	};
	const live = (id: string): InkStroke => inlineInk.strokes(N).find((s) => s.id === id)!;
	/** The newest save handed is seen to land, and a save after it (one that changed nothing) takes its changes in. */
	const landNewest = (): void => {
		landed.add(handed[handed.length - 1]!);
		inlineInk.save(N);
	};
	return { handed, bytes, landed, fileHolds, rec, read, live, landNewest };
}

type Rig = ReturnType<typeof rig>;
type Kind = "unsaved" | "handed" | "landed";

/** The version of stroke `id` this kind holds: the unsaved one, the newest handed one, or the oldest landed one. */
function versionOf(r: Rig, kind: Kind, id: string): InkStroke | null | undefined {
	if (kind === "unsaved") return unsavedChanges(r.rec())?.get(id);
	if (kind === "handed") return handedBefore(r.rec()).filter(([k]) => k === id).map(([, v]) => v).at(-1);
	return landedVersions(r.rec(), id)[0];
}

/**
 * S loaded from the file, moved once (3.3, 7.7), and its version brought to `kind`. Returns S as it stood before the move.
 * The version's points are not read here: a version may build them on first read and keep them, and every cell reads its
 * version once, after the last of its steps, so each step is one the version has to stand through unread.
 */
async function movedOnce(r: Rig, kind: Kind): Promise<InkStroke> {
	await inlineInk.ensureLoaded(N);
	const was = copyOf(r.live("S"));
	inlineInk.moveStrokes(N, ["S"], 3.3, 7.7);
	if (kind !== "unsaved") inlineInk.save(N);
	if (kind === "landed") r.landNewest();
	expect(r.handed.length, "precondition: saves handed").toBe(kind === "unsaved" ? 0 : kind === "handed" ? 1 : 2);
	expect(versionOf(r, kind, "S"), `precondition: an ${kind} version is kept`).toBeTruthy();
	return was;
}

/** One later change of S, done to the live stroke the way the overlay and its history do it. */
type Step = (r: Rig, at: { s?: InkStroke; index?: number; before?: InkStroke }) => void;

const STEPS: Record<"move" | "cut" | "reshape", ReadonlyArray<readonly [string, Step]>> = {
	move: [
		["a second move", () => inlineInk.moveStrokes(N, ["S"], -1.9, 2.6)],
		["the second move's undo", () => inlineInk.moveStrokes(N, ["S"], 1.9, -2.6)],
	],
	cut: [
		["a cut of it", (r, at) => {
			const s = r.live("S");
			const [taken] = inlineInk.takeLive(N, ["S"]);
			expect(taken?.stroke, "precondition: the cut took the live stroke").toBe(s);
			at.s = s;
			at.index = taken!.index;
			inlineInk.reinsertLive(N, [{ index: taken!.index, pieces: [pieceOf(s, "S-a", 0, 40), pieceOf(s, "S-b", 60, 100)], parent: "S" }]);
		}],
		["the cut's undo", (r, at) => {
			inlineInk.takeLive(N, ["S-a", "S-b"]);
			inlineInk.applyAddLive(N, [at.s!], [at.index!]);
			expect(r.live("S"), "precondition: the undo put back the same stroke").toBe(at.s);
		}],
		["a move of the stroke the undo put back", () => inlineInk.moveStrokes(N, ["S"], 0.7, -4.1)],
	],
	reshape: [
		["a reshape of it", (r, at) => {
			const before = copyOf(r.live("S"));
			at.before = before;
			const grown = copyOf(before);
			for (const p of grown.points) {
				p.x = p.x * 1.5 + 0.25;
				p.y = p.y * 1.5 - 0.5;
			}
			inlineInk.rewriteStrokes(N, [{ id: "S", shape: { points: grown.points, width: 3, bbox: { ...grown.bbox, width: grown.bbox.width * 1.5 } } }]);
			expect(r.live("S").width, "precondition: the reshape changed the width").toBe(3);
		}],
		["the reshape's undo", (_r, at) => {
			const before = at.before!;
			inlineInk.rewriteStrokes(N, [{ id: "S", shape: { points: before.points, width: before.width, bbox: before.bbox } }]);
		}],
		["a move after the reshape's undo", () => inlineInk.moveStrokes(N, ["S"], 0.7, -4.1)],
	],
};

/** Every run of steps from the first: a cell for each, so the step a version fails at is the cell that goes red. */
const RUNS = (Object.keys(STEPS) as Array<keyof typeof STEPS>).flatMap((change) =>
	STEPS[change].map((_, last) => [change, last + 1, STEPS[change].slice(0, last + 1).map(([label]) => label).join(", then ")] as const)
);

/** Counts of point objects the versions hold as data, read without asking a version for its points. */
function heldPoints(versions: Iterable<InkStroke | null>, live: ReadonlySet<object>): { copies: number; live: number } {
	let copies = 0, shared = 0;
	for (const v of versions) {
		if (!v) continue;
		const d = Object.getOwnPropertyDescriptor(v, "points");
		if (!d || !("value" in d) || !Array.isArray(d.value)) continue;
		for (const p of d.value as object[]) {
			if (live.has(p)) shared++;
			else copies++;
		}
	}
	return { copies, live: shared };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	inlineInk.handleDelete(N);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a large move keeps no copy of the points it moves", () => {
	it("200 strokes of 101 points moved three times, each save landed: the versions hold no point copies until read, and each reads as it stood", async () => {
		const many = Array.from({ length: 200 }, (_, i) => stroke(`m${i}`, 10 + i, 5.3, 100.37 + i * 9));
		const r = rig(many);
		await inlineInk.ensureLoaded(N);
		const ids = many.map((s) => s.id);
		const stood: InkStroke[][] = [];
		const counts: string[] = [];
		for (let move = 0; move < 3; move++) {
			stood.push(ids.map((id) => copyOf(r.live(id))));
			inlineInk.moveStrokes(N, ids, 3.3 - move, 7.7 + move);
			const liveSet = new Set<object>(inlineInk.strokes(N).flatMap((s) => s.points));
			const unsaved = heldPoints(unsavedChanges(r.rec())?.values() ?? [], liveSet);
			const landed = heldPoints(ids.flatMap((id) => landedVersions(r.rec(), id)), liveSet);
			counts.push(`move ${move + 1}: unsaved versions ${unsavedChanges(r.rec())?.size ?? 0}, point copies held ${unsaved.copies}; landed versions ${ids.flatMap((id) => landedVersions(r.rec(), id)).length}, point copies held ${landed.copies}`);
			expect(unsaved.copies, `move ${move + 1}: point copies the unsaved versions hold right after the move (one per point moved is a copy)`).toBe(0);
			expect(landed.copies, `move ${move + 1}: point copies the landed versions hold`).toBe(0);
			inlineInk.save(N);
			r.landNewest();
		}
		console.log(`[moved-versions] ${counts.join(" | ")}`);
		for (let move = 0; move < 3; move++) {
			for (let i = 0; i < ids.length; i += 37) expectStood(landedVersions(r.rec(), ids[i]!)[move], stood[move]![i]!, `landed version ${move + 1} of ${ids[i]}`);
		}
	});
});

describe.each(["unsaved", "handed", "landed"] as const)("the %s version of a moved stroke is the stroke as it stood", (kind) => {
	it.each(RUNS)("after %s step %i: %s", async (change, count, label) => {
		const r = rig();
		const was = await movedOnce(r, kind);
		const at: { s?: InkStroke; index?: number; before?: InkStroke } = {};
		for (const [, step] of STEPS[change].slice(0, count)) step(r, at);
		expectStood(versionOf(r, kind, "S"), was, `after ${label}`);
	});
});

describe.each(["unsaved", "landed"] as const)("the %s version after 1,000 moves and their undos", (kind) => {
	it("is the stroke as it stood within 1e-6", async () => {
		const r = rig();
		const was = await movedOnce(r, kind);
		for (let i = 0; i < 1000; i++) {
			const dx = 0.37 + (i % 13) * 1.71, dy = -2.9 + (i % 7) * 0.83;
			inlineInk.moveStrokes(N, ["S"], dx, dy);
			if (i % 2 === 0) inlineInk.moveStrokes(N, ["S"], -dx, -dy);
		}
		const v = versionOf(r, kind, "S")!;
		let worst = 0;
		for (let i = 0; i < v.points.length; i++) worst = Math.max(worst, Math.abs(v.points[i]!.x - was.points[i]!.x), Math.abs(v.points[i]!.y - was.points[i]!.y));
		console.log(`[moved-versions] ${kind} after 1,000 moves and 500 undos: farthest point ${worst}`);
		expect(worst, "the farthest point from where it stood").toBeLessThanOrEqual(1e-6);
		expect([v.createdAt, v.tool, v.color, v.width], "createdAt, tool, colour and width as they stood").toEqual([was.createdAt, was.tool, was.color, was.width]);
	});
});

describe("each save keeps the version its own move began from", () => {
	it("moved, saved, moved again: the first save's version is the stroke before the first move, the new unsaved one the stroke before the second", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(N);
		const p0 = copyOf(r.live("S"));
		inlineInk.moveStrokes(N, ["S"], 3.3, 7.7);
		inlineInk.save(N);
		const p1 = copyOf(r.live("S"));
		inlineInk.moveStrokes(N, ["S"], -1.9, 2.6);
		expectStood(versionOf(r, "handed", "S"), p0, "the first save's version after the second move");
		expectStood(versionOf(r, "unsaved", "S"), p1, "the unsaved version of the second move");
	});

	it("moved, saved, moved again, saved, landed, moved a third time: the two landed versions are the stroke before each of the first two moves", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(N);
		const p0 = copyOf(r.live("S"));
		inlineInk.moveStrokes(N, ["S"], 3.3, 7.7);
		inlineInk.save(N);
		const p1 = copyOf(r.live("S"));
		inlineInk.moveStrokes(N, ["S"], -1.9, 2.6);
		inlineInk.save(N);
		r.landNewest();
		inlineInk.moveStrokes(N, ["S"], 0.7, -4.1);
		const kept = landedVersions(r.rec(), "S");
		expect(kept.length, "one landed version per landed change").toBe(2);
		expectStood(kept[0], p0, "landed version 1 after a third move");
		expectStood(kept[1], p1, "landed version 2 after a third move");
	});
});

describe("a read of the note's file that rescales its ink to the file's font size", () => {
	it("this note moved S and did not save, the other device cut S under font size 16 where this note latched 20: S is drawn once, and its version is S as it stood, unscaled", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(N);
		expect(inlineInk.setFontRefPx(N, 20), "precondition: the note latched 20").toBe(true);
		const was = copyOf(r.live("S"));
		inlineInk.moveStrokes(N, ["S"], 3.3, 7.7);
		r.fileHolds([pieceOf(was, "S-x", 0, 30), pieceOf(was, "S-y", 70, 100)], 16);
		const after = await r.read();
		expect(inlineInk.fontRefPx(N), "precondition: the file's 16 now names the note's frame").toBe(16);
		expect(after.map((s) => s.id).filter((id) => id.startsWith("S")), "S and the other device's pieces of it are drawn twice, or S is gone").toEqual(["S"]);
		const v = unsavedChanges(r.rec())?.get("S") ?? handedBefore(r.rec()).filter(([k]) => k === "S").map(([, x]) => x).at(-1);
		expectStood(v, was, "S's version after the read");
	});
});

describe("the same edits save the same bytes", () => {
	it("moves, a landed save, a reshape, a cut and its undo, and a read of the other device's cut: every save's bytes", async () => {
		const r = rig([stroke("S", 1), stroke("T", 2, 7.9, 160.11), stroke("U", 3, 2.2, 220.53)]);
		await inlineInk.ensureLoaded(N);
		const sWas = copyOf(r.live("S"));
		inlineInk.moveStrokes(N, ["S", "T", "U"], 3.3, 7.7);
		inlineInk.save(N);
		r.landNewest();
		const t = copyOf(r.live("T"));
		for (const p of t.points) p.y = p.y * 1.25 - 3.5;
		inlineInk.rewriteStrokes(N, [{ id: "T", shape: { points: t.points, width: 2.5, bbox: t.bbox } }]);
		inlineInk.save(N);
		const u = r.live("U");
		const [taken] = inlineInk.takeLive(N, ["U"]);
		inlineInk.reinsertLive(N, [{ index: taken!.index, pieces: [pieceOf(u, "U-a", 0, 50)], parent: "U" }]);
		inlineInk.save(N);
		inlineInk.takeLive(N, ["U-a"]);
		inlineInk.applyAddLive(N, [u], [taken!.index]);
		inlineInk.moveStrokes(N, ["U"], -1.9, 2.6);
		inlineInk.save(N);
		// The other device read the file before this note's first save landed, and cut S as it stood then.
		r.fileHolds([pieceOf(sWas, "S-p", 10, 45), copyOf(r.live("T")), copyOf(r.live("U"))]);
		const after = await r.read();
		expect(after.map((s) => s.id).filter((id) => id.startsWith("S")), "S and the other device's piece of it are drawn twice").toEqual(["S-p"]);
		inlineInk.save(N);
		const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.bytes.join("\n")))), (b) => b.toString(16).padStart(2, "0")).join("");
		console.log(`[moved-versions] saves ${r.bytes.length}, bytes sha256 ${digest}`);
		expect(digest, "the saved bytes of these edits at 16515593").toBe(SAVED_AT_BASE);
	});
});

/** sha256 of every save's bytes for the edits above, joined by newlines, as 16515593 writes them. */
const SAVED_AT_BASE = "a1532f08bd0a94ad47f2a53eb26b80657826125a3d9058ea8afe0041edd94786";
