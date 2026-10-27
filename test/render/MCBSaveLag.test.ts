/**
 * WHAT THE SAVE OF THE MCB EXAM 3 PAGE (28,358 STROKES, 25 MB) COSTS THE MAIN THREAD WHILE A PEN WRITES, AND AT A PAGE SWITCH
 * WITH THE PEN DOWN.
 *
 * The page's sidecar is written by the real PageStore through an in-memory adapter (mcbSaveLagPage.ts), wired to the inline ink
 * as main.ts wires it. Every adapter call settles one task later, as real I/O does, and a write encodes the string once, as
 * Obsidian's write does. A timer save runs at most every 5 s while the page is dirty: it serializes in 4 ms slices between
 * strokes, writes, then reads back the file it replaces and stamps it to tell its own bytes from another writer's.
 *
 * One mount, two phases:
 *  1. write: 26 pen strokes with a 400 ms pause after each, about 24 s, so at least three timer saves run.
 *  2. flush: the pen goes down and stays down, and flushPage runs on the page, as a switch to another note does; then the lift.
 *
 * The instrument: the save's own main-thread tasks. A save's code runs from a resume (its start, an adapter call settling, a
 * slice pause ending) to its next yield (an adapter call, whose synchronous part counts, or a slice pause), so each such span
 * is one task of the save. The span of the write includes its encode. Printed per save: slices, the task from the last
 * serializer slice to the write (the join), the write's task and its encode, the closing tasks after the write (the read-back
 * of the replaced file), every task over 8 ms. A setTimeout(0) gap probe and long tasks are printed beside it as a cross-check
 * (each save task over the bar must show as a gap at least as long; one that does not is an unrecorded wait, named "unseen").
 * After the run, with no save in flight, the stamp the store keeps for its own file must be contentStamp of the bytes written.
 *
 * Bar, the frame: no save task over 16.7 ms, its encode not counted, in a writing pause (a pen-up to the next pen-down) across
 * the timer saves while writing, nor in the flush with the pen down. The encode is printed apart and not gated: it is the
 * adapter's cost, and moving it is a separate step decided on its number. Red first: the sources before the sliced stamps
 * (the new text stamped whole after the slices, the replaced file stamped whole) red; so does each stamp put back whole.
 *
 * The park check: while writing, when a timer's save moves the live sidecar aside (rename(final, aside)), the page puts a pen
 * down and holds it PARK_HOLD_MS (500 ms). From that rename until rename(tmp, final) the page has no live sidecar, so the
 * read-back between them must not wait for the lift: at every such save rename(tmp, final) arrives before the lift and within
 * PARK_BAR_MS of the aside rename. Red first: the read-back stamped with the serializer's pen-parked pause reds.
 *
 * Device scale: forced by Chromium's --force-device-scale-factor, HW_MCBLAG_DSF (default 2); the output names the flag and the
 * page's devicePixelRatio, and the premise holds them equal.
 *
 * Not covered: the adapter's own file system work beyond the encode (Obsidian's read decodes 25 MB on the main thread, not
 * modelled), vault events the real adapter raises, sync tools, a slower device's CPU.
 *
 * Run: HW_MCBLAG_NOTE=<note .md> HW_MCBLAG_INK=<ink .json> HW_MCBSAVE_OUT=<file> HW_MCBLAG_SHA=<sha> [HW_MCBLAG_DSF=<scale>]
 *      npx vitest run --config vitest.render.mts test/render/MCBSaveLag.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type CDPSession } from "playwright";
import { penMove, penPress, penRelease } from "./cdpPen";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const NOTE_PATH = process.env.HW_MCBLAG_NOTE ?? "", INK_PATH = process.env.HW_MCBLAG_INK ?? "", OUT = process.env.HW_MCBSAVE_OUT ?? "", SHA = process.env.HW_MCBLAG_SHA ?? "";
const HAVE = !!NOTE_PATH && !!INK_PATH && existsSync(NOTE_PATH) && existsSync(INK_PATH);
const PAGE_ID = "cf77b392-e4c0-47b3-b87a-b9583f5884cb";
const PANE = { w: 1184, h: 824, left: 300, top: 20 };
const DSF = Number(process.env.HW_MCBLAG_DSF ?? "2"), STROKES = 26, PAUSE_MS = 400;
/** The frame at 60 Hz. */
const BAR = 16.7;
/**
 * The park check's bar: from the live file's move aside to rename(tmp, final), with a pen held down from the first. The rig's
 * setTimeout(0) ticks land about 15.6 ms apart, so an unparked tail costs about 130 ms here; a save that waits for the lift
 * takes the whole 500 ms hold.
 */
const PARK_BAR_MS = 300;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./mcbSaveLagPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function stroke(cdp: CDPSession, x: number, y: number, w: number) {
	await penPress(cdp, x, y);
	for (let k = 1; k <= 16; k++) { await penMove(cdp, x + (w * k) / 16, y + 10 * Math.sin(k / 2)); await sleep(16); }
	await penRelease(cdp, x + w, y + 10 * Math.sin(8));
}

type Ev = { k: string; ph: string; t: number; ms?: number; end?: number; res?: number; id?: number; save?: number; op?: string; len?: number; what?: string; i?: number; delay?: number; path?: string; to?: string };
type Task = { from: number; to: number; ms: number; ends: string; encodeMs: number };

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The save's own tasks, from its start, adapter calls and slice pauses: each task runs from a resume to the next yield (an
 * adapter call's synchronous part included), and the last one to the save's end. Each yield resumes at its own settling (an
 * adapter call's by its id, a pause's at its end), never at the nearest later time: the next call often starts in the
 * millisecond the previous one settled, and a nearest-time match then counts the next wait as work.
 */
function tasksOf(ev: Ev[], s: Ev): Task[] {
	const end = s.end ?? s.t;
	const inSave = (t: number) => t >= s.t && t <= end;
	const settled = new Map(ev.filter(e => e.k === "resume").map(e => [e.id, e.t] as const));
	const yields = [
		...ev.filter(e => e.k === "io" && inSave(e.t)).map(e => ({ y: e.t, e: e.t + (e.ms ?? 0), ends: "io:" + e.op, res: settled.get(e.id) ?? end })),
		...ev.filter(e => e.k === "slice" && e.save === s.id).map(e => ({ y: e.t, e: e.t, ends: "pause", res: e.res ?? e.t })),
	].sort((a, b) => a.y - b.y);
	const encodes = ev.filter(e => e.k === "encode" && inSave(e.t));
	const tasks: Task[] = [];
	let from = s.t;
	const add = (to: number, ends: string) => {
		const enc = encodes.filter(x => x.t >= from && x.t <= to).reduce((a, x) => a + (x.ms ?? 0), 0);
		tasks.push({ from, to, ms: to - from, ends, encodeMs: enc });
	};
	for (const y of yields) {
		add(y.e, y.ends);
		from = y.res;
	}
	add(end, "end");
	return tasks;
}

/** The bar and the per-save rows, from the page's events. */
function verdict(ev: Ev[]) {
	const ups = ev.filter(e => e.k === "up" && e.ph === "write"), downs = ev.filter(e => e.k === "mark" && e.what === "down").map(e => e.t).sort((a, b) => a - b);
	const pauses = ups.map(u => { const end = u.t + (u.ms ?? 0), next = downs.find(d => d > end); return { from: end, to: next ?? end + PAUSE_MS }; });
	const inPause = (b: { from: number; to: number }) => pauses.some(p => overlaps(b.from, b.to, p.from, p.to));
	const saves = ev.filter(e => e.k === "save").sort((a, b) => a.t - b.t);
	const blocks = ev.filter(e => e.k === "long" || e.k === "gap").map(e => e.k === "long" ? { k: "long", from: e.t, to: e.t + (e.ms ?? 0), ms: e.ms ?? 0 } : { k: "gap", from: e.t - (e.ms ?? 0), to: e.t, ms: e.ms ?? 0 });
	const seen = (x: { from: number; to: number }) => Math.max(0, ...blocks.filter(b => overlaps(b.from, b.to, x.from, x.to)).map(b => b.ms));
	const overBar: { save: number; ph: string; ends: string; ms: number; encodeMs: number; gapSeen: number; unseen: boolean }[] = [];
	const rows = saves.map(s => {
		const end = s.end ?? s.t;
		const tasks = tasksOf(ev, s);
		const writes = ev.filter(e => e.k === "io" && e.op === "write" && e.t >= s.t && e.t <= end);
		const reads = ev.filter(e => e.k === "io" && e.op === "read" && e.t >= s.t && e.t <= end);
		const w = writes[0];
		const sl = ev.filter(e => e.k === "slice" && e.save === s.id);
		const serSlices = w ? sl.filter(x => x.t < w.t) : sl, backSlices = w ? sl.filter(x => x.t > w.t) : [];
		const lastSer = serSlices.length ? Math.max(...serSlices.map(x => x.res ?? x.t)) : s.t;
		const join = tasks.find(t => t.from >= lastSer);
		const writeTask = w ? tasks.find(t => t.ends === "io:write" && t.to === w.t + (w.ms ?? 0)) : undefined;
		const after = w ? tasks.filter(t => t.from >= w.t + (w.ms ?? 0)) : [];
		for (const t of tasks) {
			if (t.ms - t.encodeMs <= BAR) continue;
			if (s.ph === "write" && !inPause(t)) continue;
			const g = seen(t);
			overBar.push({ save: s.id ?? 0, ph: s.ph, ends: t.ends, ms: r1(t.ms), encodeMs: r1(t.encodeMs), gapSeen: Math.round(g), unseen: g < t.ms - 8 });
		}
		const b = blocks.filter(x => overlaps(x.from, x.to, s.t, end));
		return { id: s.id, ph: s.ph, start: Math.round(s.t), ms: Math.round(end - s.t), tasks: tasks.length, serializerSlices: serSlices.length, readBackSlices: backSlices.length,
			longestTask: r1(Math.max(0, ...tasks.map(t => t.ms - t.encodeMs))), joinTask: join ? r1(join.ms) : null, writeTask: writeTask ? r1(writeTask.ms) : null,
			encodeMs: writeTask ? r1(writeTask.encodeMs) : null, closingTask: after.length ? r1(Math.max(...after.map(t => t.ms))) : null,
			over8: tasks.filter(t => t.ms > 8).map(t => ({ ends: t.ends, ms: r1(t.ms), enc: r1(t.encodeMs), atWrite: w ? Math.round(t.from - w.t) : null })),
			writeLen: w ? w.len : null, writes: writes.length, reads: reads.map(r => ({ len: r.len, ms: r1(r.ms ?? 0) })),
			gaps17: b.filter(x => x.k === "gap" && x.ms > BAR).map(x => Math.round(x.ms)), longs: b.filter(x => x.k === "long").map(x => Math.round(x.ms)) };
	});
	const pd = ev.filter(e => e.k === "pdown");
	const flushDown = ev.find(e => e.k === "mark" && e.what === "down" && e.i === STROKES)?.t ?? Infinity;
	const encodes = ev.filter(e => e.k === "encode");
	// Each park pen: its save's move of the live file aside (the rename it came down at) and the next rename of the tmp.
	const parks = ev.filter(e => e.k === "parkDown").map(p => {
		const s = saves.find(x => x.id === p.save), end = s?.end ?? p.t;
		const renames = ev.filter(e => e.k === "io" && e.op === "rename" && e.t >= (s?.t ?? p.t) && e.t <= end);
		const aside = renames.filter(e => !e.path?.endsWith(".tmp") && e.t <= p.t).pop();
		const tmp = aside ? renames.find(e => e.path?.endsWith(".tmp") && e.t > aside.t) : undefined;
		const up = ev.find(e => e.k === "parkUp" && e.save === p.save);
		return { save: p.save, asideToTmpMs: aside && tmp ? r1(tmp.t - aside.t) : null, liftAtMs: aside && up ? r1(up.t - aside.t) : null, beforeLift: !!(tmp && up && tmp.t < up.t) };
	});
	return { bar: BAR, parkBarMs: PARK_BAR_MS, parks, parkOverBar: parks.filter(p => p.asideToTmpMs === null || p.asideToTmpMs > PARK_BAR_MS || !p.beforeLift).length, ups: ups.length, upMax: r1(Math.max(0, ...ups.map(u => u.ms ?? 0))), saves: rows.length, savesWhileWriting: rows.filter(r => r.start < flushDown && r.ph === "write").length,
		flushSaves: rows.filter(r => r.ph === "flush").length, saveTaskOverBar: overBar.length, overBar,
		encodes: encodes.map(e => ({ ms: r1(e.ms ?? 0), len: e.len })), encodeOverBar: encodes.filter(e => (e.ms ?? 0) > BAR).length,
		ioCalls: ev.filter(e => e.k === "io").length, ioResumes: ev.filter(e => e.k === "resume").length,
		gapsOver17InPauses: blocks.filter(b => b.k === "gap" && b.ms > BAR && inPause(b)).length, penDownDelayMax: Math.round(Math.max(0, ...pd.map(p => p.delay ?? 0))),
		flush: ev.filter(e => e.k === "flush").map(e => Math.round(e.ms ?? 0)), rows };
}

it.skipIf(!HAVE)("MCB EXAM 3: no save task over a frame in a writing pause, nor in a flush with the pen down", async () => {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	const out: Record<string, unknown> = { sha: SHA, dsfFlag: DSF, bar: BAR, pane: PANE, strokes: STROKES, pauseMs: PAUSE_MS };
	try {
		const note = readFileSync(NOTE_PATH, "utf8"), ink = readFileSync(INK_PATH, "utf8");
		const want = (JSON.parse(ink) as { strokes: unknown[] }).strokes.length;
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([n, k, id, w, h, c]) => (window as any).mcbSave.mount(n, k, id, w, h, c), [note, ink, PAGE_ID, PANE.w, PANE.h, want] as const) as any;
		out.mounted = mounted;
		console.log("MCBSAVE mounted " + JSON.stringify(mounted));
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded through the store").toBe(want);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 3);
		await sleep(1500);
		const probes = await page.evaluate(() => (window as any).mcbSave.record());
		out.probes = probes;
		expect(probes.writePending, "premise: the save probe is on").toBe(true);
		expect(probes.penUp, "premise: the commit probe is on").toBe(true);
		expect(probes.penPause, "premise: the slice probe is on").toBe(true);
		const cdp = await context.newCDPSession(page);
		await page.evaluate(() => (window as any).mcbSave.phase("write"));
		const t0 = Date.now();
		for (let i = 0; i < STROKES; i++) {
			const x = PANE.left + 160 + (i % 5) * 180, y = PANE.top + 260 + Math.floor(i / 5) * 60;
			await page.evaluate(k => (window as any).mcbSave.mark("down", k), i);
			await stroke(cdp, x, y, 120);
			await sleep(PAUSE_MS);
		}
		out.writeWallMs = Date.now() - t0;
		await page.evaluate(() => (window as any).mcbSave.phase("flush"));
		const fx = PANE.left + 160, fy = PANE.top + 660;
		await page.evaluate(k => (window as any).mcbSave.mark("down", k), STROKES);
		await penPress(cdp, fx, fy);
		for (let k = 1; k <= 4; k++) { await penMove(cdp, fx + 10 * k, fy); await sleep(16); }
		const flush = await page.evaluate(() => (window as any).mcbSave.flush()) as { ms: number; ok: boolean };
		await penRelease(cdp, fx + 40, fy);
		out.flushResult = flush;
		await sleep(2500);
		out.end = await page.evaluate(() => (window as any).mcbSave.state());
		const rec = await page.evaluate(() => (window as any).mcbSave.stop()) as { ev: Ev[]; scheduleAsks: number };
		out.ev = rec.ev; out.scheduleAsks = rec.scheduleAsks;
		const stamp = await page.evaluate(() => (window as any).mcbSave.check()) as { idle: boolean; len: number; kept: string | null; file: string | null };
		out.stampCheck = stamp;
		const v = verdict(rec.ev);
		out.verdict = v;
		console.log("MCBSAVE verdict " + JSON.stringify({ ...v, rows: undefined }));
		for (const r of v.rows) console.log("MCBSAVE save " + JSON.stringify(r));
		if (OUT) writeFileSync(OUT, JSON.stringify(out));
		expect(errors).toEqual([]);
		expect(v.ups, "premise: every stroke committed").toBe(STROKES);
		expect(v.savesWhileWriting, "premise: at least three timer saves ran while writing").toBeGreaterThanOrEqual(3);
		expect(v.flushSaves, "premise: the flush wrote the page").toBeGreaterThanOrEqual(1);
		expect(flush.ok, "premise: the flush succeeded").toBe(true);
		expect(v.ioResumes, "premise: every adapter call settled a task later").toBe(v.ioCalls);
		for (const r of v.rows) {
			expect(r.writes, `premise: save ${r.id} wrote`).toBe(1);
			expect(r.reads.some(x => (x.len ?? 0) > 20_000_000), `premise: save ${r.id} read back the replaced file`).toBe(true);
		}
		expect(stamp.idle, "premise: no save in flight at the stamp check").toBe(true);
		expect(stamp.len, "premise: the sidecar is the 25 MB page").toBeGreaterThan(20_000_000);
		expect(stamp.kept, "the stamp the store keeps for its own file is contentStamp of the bytes written").toBe(stamp.file);
		expect(v.parks.length, "premise: a pen came down at the live file's move aside in at least three timer saves").toBeGreaterThanOrEqual(3);
		expect.soft(v.saveTaskOverBar, "no save task over a frame (16.7 ms, encode apart) in a writing pause or the flush").toBe(0);
		expect.soft(v.parkOverBar, `with a pen down, rename(tmp, final) before the lift and within ${PARK_BAR_MS} ms of the live file's move aside`).toBe(0);
	} finally {
		if (OUT && !existsSync(OUT)) writeFileSync(OUT, JSON.stringify({ ...out, errors, incomplete: true }));
		await context.close();
	}
}, 300_000);
