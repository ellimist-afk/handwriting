/**
 * THE SAVE DOES NOT RUN WHILE THE PEN IS DOWN. On a big note the store's bounded-dirty timer fires 5 s into
 * continuous writing and the save serializes the whole page on the main thread in one task: 38 ms at about 3000
 * strokes, which is two or more frames of a stroke in progress. Alan's screen: a hitch every 5 s while writing.
 *
 * The rig: the real PageStore in Chromium on an in-memory adapter whose calls resolve on the next task, as disk IO
 * does. The page is Alan's own ink (test/render/fixtures/alan-ink-75d1627a.json, 1527 strokes, about 234 points
 * each), tiled to 600 and to 3000 strokes. Continuous writing: strokes of 300 ms pen down and 100 ms pen up, the
 * page scheduled at every pen-up, as the overlay does on a stroke commit; the 5 s timer lands inside a stroke. A
 * message loop runs through the whole run and records the gap between its turns; a save is the store's writePending
 * from its call to its end, and its worst task is the worst gap that overlaps it (the serialization runs several
 * awaits before the write). Asserted: no save starts while
 * the pen is down, and the page written within 1.5 s of the last pen-up. In the two runs of 600 and 3000 strokes the
 * stroke after the bound's lift starts as that lift's save begins, so the save runs into a pen-down on any machine.
 * That save holds no task over 16.7 ms (one frame) while the pen is down, and writes nothing during the stroke: it
 * serializes in slices and waits for the lift.
 * A save's task with the pen down is a gap of the message loop that ends with the pen down while that save runs.
 * Printed, not asserted: the worst gap of any kind with the pen down and up (the heap is large and collections land
 * anywhere: 27 to 35 ms gaps away from any save at base).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

const PAGE = `
import { PageStore } from "../../src/persistence/PageStore";
import { parsePage } from "../../src/model/PageData";
import fixture from "./fixtures/alan-ink-75d1627a.json";

const nextTask = () => new Promise(r => setTimeout(r, 0));
function memoryAdapter(log) {
	const files = new Map(), dirs = new Set();
	return {
		files,
		async exists(p) { await nextTask(); return files.has(p) || dirs.has(p); },
		async read(p) { await nextTask(); if (!files.has(p)) throw new Error("no file " + p); return files.get(p); },
		async write(p, data) { log.push({ at: performance.now(), path: p, bytes: data.length, data }); await nextTask(); files.set(p, data); },
		async rename(a, b) { await nextTask(); files.set(b, files.get(a)); files.delete(a); },
		async remove(p) { await nextTask(); files.delete(p); },
		async mkdir(p) { await nextTask(); dirs.add(p); },
		async stat(p) { await nextTask(); return files.has(p) ? { mtime: Date.now() } : null; },
		async list() { await nextTask(); return { files: [...files.keys()], folders: [...dirs] }; },
	};
}

function tiled(count) {
	const base = parsePage(JSON.stringify(fixture), fixture.pageId).data;
	const strokes = [];
	for (let i = 0; strokes.length < count; i++) {
		const s = base.strokes[i % base.strokes.length];
		strokes.push({ ...s, id: s.id + "-" + Math.floor(i / base.strokes.length) });
	}
	return { ...base, strokes };
}

/** A store on the in-memory adapter, its writes logged, and every save timed from writePending's call to its end. */
function rig(count) {
	const writes = [], saves = [];
	const adapter = memoryAdapter(writes);
	const store = new PageStore({ vault: { adapter } });
	const page = tiled(count);
	const state = { penDown: false, onSave: null };
	const writePending = PageStore.prototype.writePending;
	store.writePending = async function (id, ...rest) {
		const save = { start: performance.now(), end: undefined, worst: 0, worstDown: 0, penDown: state.penDown, startDown: state.penDown };
		saves.push(save);
		const onSave = state.onSave;
		state.onSave = null;
		onSave?.();
		try { return await writePending.call(this, id, ...rest); } finally { save.end = performance.now(); }
	};
	const pen = (type, id = 7) => { state.penDown = type === "pointerdown"; window.dispatchEvent(new PointerEvent(type, { pointerType: "pen", pointerId: id, isPrimary: true })); };
	const written = (from) => writes.filter(w => w.path.includes(page.pageId) && w.at >= from).map(w => w.at - from);
	return { writes, saves, store, page, state, pen, written };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(test, ms) { const t = performance.now(); while (!test() && performance.now() - t < ms) await wait(25); }

window.saveStall = {
	/**
	 * A pen contact that commits no stroke: the page scheduled at a lift, then a 1.5 s contact with no commit, so the
	 * quiet timer fires with the pen down; the lift schedules nothing. Returns the writes against that lift.
	 */
	/**
	 * Nonstop writing where every lift commits a stroke, as the overlay does: the pen events go to a surface element,
	 * whose own pointerup handler adds one stroke (id "lift-<n>") and schedules the grown page, in the same dispatch
	 * as the store's capture listener on the window, which runs first. (Dispatched on the window itself, Chromium runs
	 * the window's listeners in the order they were added, and the store's, added at the first schedule, would run
	 * last.) Strokes of 300 ms down and 100 ms up until 4.6 s after the first commit, then one 800 ms stroke
	 * that spans the 5 s bound, so the store holds the page through it and writes at its lift; then three more strokes.
	 * Returns, for each save, the last lift before it and whether its write holds that lift's stroke.
	 */
	async growingPage(count) {
		const r = rig(count), id = r.page.pageId;
		let page = r.page, lifts = 0;
		const template = page.strokes[0];
		const commit = (e) => {
			if (e.pointerType !== "pen") return;
			page = { ...page, strokes: [...page.strokes, { ...template, id: "lift-" + lifts }] };
			lifts++;
			r.store.schedule(id, page);
		};
		const surface = document.body.appendChild(document.createElement("div"));
		surface.addEventListener("pointerup", commit);
		const pen = (type) => { r.state.penDown = type === "pointerdown"; surface.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "pen", pointerId: 7, isPrimary: true })); };
		const t0 = performance.now(), liftAt = [];
		// Each lift's time is taken before its dispatch: a save started inside that dispatch counts as after it.
		const stroke = async (ms) => { pen("pointerdown"); await wait(ms); liftAt.push(performance.now()); pen("pointerup"); await wait(100); };
		do await stroke(300); while (performance.now() - liftAt[0] < 4600);
		await stroke(800);
		const boundLift = liftAt.length - 1;
		for (let i = 0; i < 3; i++) await stroke(300);
		const lastUp = performance.now();
		await until(() => r.written(lastUp).length > 0, 3000);
		await wait(50);
		surface.remove();
		const tmp = r.writes.filter(w => w.path.includes(id) && w.path.endsWith(".tmp"));
		return {
			lifts, boundLift, bound: Math.round(liftAt[0] + 5000 - t0), boundLiftAt: Math.round(liftAt[boundLift] - t0),
			saves: r.saves.map(x => {
				const before = liftAt.filter(t => t <= x.start).length - 1;
				const write = tmp.find(w => w.at >= x.start);
				return { at: Math.round(x.start - t0), lastLift: before, holdsIt: before < 0 ? null : !!write && write.data.includes('"lift-' + before + '"') };
			}),
		};
	},
	async noCommitContact(count) {
		const r = rig(count), id = r.page.pageId;
		r.pen("pointerdown"); await wait(100); r.pen("pointerup"); r.store.schedule(id, r.page);
		await wait(100);
		r.pen("pointerdown"); const down = performance.now();
		await wait(1500);
		const duringContact = r.written(down).length;
		r.pen("pointerup"); const up = performance.now();
		await until(() => r.written(up).length > 0, 2500);
		return { duringContact, afterLift: r.written(up).map(Math.round) };
	},
	/**
	 * A pen whose lift never arrives: the page scheduled (its first change), then a contact that never ends. Then the
	 * next real contact with another pointer id: scheduled just before it, held through 1.5 s of contact, lifted.
	 */
	async lostLift(count) {
		const r = rig(count), id = r.page.pageId;
		r.store.schedule(id, r.page); const first = performance.now();
		r.pen("pointerdown", 8);
		await until(() => r.written(first).length > 0, 11500);
		const capWrite = r.written(first)[0];
		const capSave = r.saves.length ? r.saves[0].start - first : undefined;
		await wait(300);
		r.store.schedule(id, r.page); r.pen("pointerdown", 9); const down = performance.now();
		await wait(1500);
		const duringContact = r.written(down).length;
		r.pen("pointerup", 9); const up = performance.now();
		await until(() => r.written(up).length > 0, 2500);
		return { capWrite: capWrite === undefined ? null : Math.round(capWrite), capSave: capSave === undefined ? null : Math.round(capSave), duringContact, afterLift: r.written(up).map(Math.round) };
	},
	async run(count, strokesN = 18, downAtSave = false) {
		const r = rig(count), { writes, saves, store, page } = r;
		const pageId = page.pageId;
		// The gap probe: a message loop through the whole run. A save is the store's writePending from its call to its
		// end; every probe gap that overlaps it is the save's.
		let running = true, last = performance.now(), worstDown = 0, worstUp = 0, worstDownAt = 0;
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			const now = performance.now(), gap = now - last;
			const penDown = r.state.penDown;
			if (penDown) { if (gap > worstDown) { worstDown = gap; worstDownAt = now; } } else if (gap > worstUp) worstUp = gap;
			for (const save of saves) if (save.start <= now && (save.end === undefined || save.end >= last)) { save.worst = Math.max(save.worst, gap); if (penDown) save.worstDown = Math.max(save.worstDown, gap); save.penDown ||= penDown; }
			last = now;
			if (running) channel.port2.postMessage(0);
		};
		channel.port2.postMessage(0);
		const pen = r.pen;
		const t0 = performance.now();
		const marks = [];
		// 18 strokes: 7.2 s of writing; the first schedule at 0.3 s puts the 5 s timer at 5.3 s, inside the 14th stroke.
		// With downAtSave, a lift that starts a save starts the next stroke as soon as the save has begun, so that stroke
		// lands inside the save wherever its long task falls, on any machine; other lifts last 100 ms.
		for (let i = 0; i < strokesN; i++) {
			pen("pointerdown"); marks.push({ down: performance.now() - t0 });
			await wait(300);
			pen("pointerup"); marks[marks.length - 1].up = performance.now() - t0;
			store.schedule(pageId, page);
			const started = downAtSave ? new Promise(resolve => { r.state.onSave = resolve; }) : null;
			await (started ? Promise.race([wait(100), started]) : wait(100));
			r.state.onSave = null;
		}
		const lastUp = performance.now();
		const writtenSince = () => writes.filter(w => w.path.includes(pageId) && w.at >= lastUp).length;
		while (writtenSince() === 0 && performance.now() - lastUp < 3000) await wait(25);
		await wait(50);
		running = false;
		const inStroke = at => marks.some(m => at - t0 >= m.down && (m.up === undefined || at - t0 <= m.up));
		return {
			count, bytes: JSON.stringify(page).length, worstDown, worstDownAt: worstDownAt - t0, worstUp,
			writes: writes.filter(w => w.path.includes(pageId)).map(w => ({ at: Math.round(w.at - t0), afterLastUp: Math.round(w.at - lastUp), duringStroke: inStroke(w.at), path: w.path.split("/").pop(), bytes: w.bytes })),
			lastUp: Math.round(lastUp - t0),
			saves: saves.map(x => ({ at: Math.round(x.start - t0), ms: Math.round((x.end - x.start) * 10) / 10, worstTask: Math.round(x.worst * 10) / 10, worstDown: Math.round(x.worstDown * 10) / 10, penDown: x.penDown, startDown: x.startDown })),
		};
	},
};
`;

const FRAME_MS = 16.7;
let script: string;
let browser: Browser;
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "saveStallPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", loader: { ".json": "json" },
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

type Run = { count: number; bytes: number; worstDown: number; worstDownAt: number; worstUp: number; lastUp: number;
	writes: { at: number; afterLastUp: number; duringStroke: boolean; path: string; bytes: number }[];
	saves: { at: number; ms: number; worstTask: number; worstDown: number; penDown: boolean; startDown: boolean }[] };

for (const count of [600, 3000]) it(`${count} strokes: no save starts with the pen down, the page is saved after it lifts, and a save running into the next pen-down holds no task over one frame and writes nothing during the stroke`, async () => {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addScriptTag({ content: script });
		// The next stroke starts as the save at the bound's lift begins: the save runs into it however fast this machine
		// serializes, and the bars below have something to read.
		const r = await page.evaluate(n => (window as any).saveStall.run(n, 18, true), count) as Run;
		// eslint-disable-next-line no-console
		console.log(`SAVE STALL ${count} strokes (${(r.bytes / 1e6).toFixed(2)} MB): worst task with the pen down ${r.worstDown.toFixed(1)} ms at ${r.worstDownAt.toFixed(0)} ms, with it up ${r.worstUp.toFixed(1)} ms; last pen-up ${r.lastUp} ms; saves ${JSON.stringify(r.saves)}; writes ${JSON.stringify(r.writes)}`);
		expect(errors, "page errors").toEqual([]);
		expect(r.writes.length, "the page was never saved").toBeGreaterThan(0);
		expect(r.writes.some(w => w.afterLastUp >= 0 && w.afterLastUp <= 1500), "no save within 1.5 s of the last pen-up").toBe(true);
		const overlap = r.saves.filter(y => y.penDown);
		// eslint-disable-next-line no-console
		console.log(`SAVE OVERLAP ${count} strokes: saves that ran into a pen-down ${overlap.length}, worst task with the pen down ${Math.max(0, ...overlap.map(y => y.worstDown)).toFixed(1)} ms (one frame is ${FRAME_MS} ms), writes during a stroke ${r.writes.filter(w => w.duringStroke).length}`);
		expect(r.saves.filter(s => s.startDown), "a save started with the pen down").toEqual([]);
		expect(overlap.length, "premise: a save ran into a pen-down").toBeGreaterThan(0);
		expect(overlap.filter(y => y.worstDown > FRAME_MS), `a save held a task over one frame (${FRAME_MS} ms) with the pen down`).toEqual([]);
		expect(r.writes.filter(w => w.duringStroke), "a save wrote during a stroke").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);

// Nonstop writing still reaches disk inside the writing: 40 strokes, 16 s, no gap long enough for the quiet period.
// The 5 s bound holds the page while the pen is down and writes it at the next lift, so a save starts before the last
// lift and none starts with the pen down.
it("600 strokes, 16 s of nonstop writing: the page is saved before the writing ends, and never starting with the pen down", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).saveStall.run(600, 40)) as Run;
		// eslint-disable-next-line no-console
		console.log(`SAVE BOUND 600 strokes, 40 strokes of writing: last pen-up ${r.lastUp} ms; saves ${JSON.stringify(r.saves)}; writes ${JSON.stringify(r.writes.map(w => ({ at: w.at, afterLastUp: w.afterLastUp, duringStroke: w.duringStroke })))}`);
		expect(r.saves.filter(x => x.at < r.lastUp).length, "no save in 16 s of nonstop writing").toBeGreaterThan(0);
		expect(r.saves.filter(x => x.startDown), "a save started with the pen down").toEqual([]);
	} finally {
		await page.close();
	}
}, 120_000);

// A contact that commits nothing still lets a held save go: the quiet timer fires during it and the lift writes.
it("a save timer that fires during a pen contact that commits nothing writes the page within 1 s of that lift", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).saveStall.noCommitContact(600)) as { duringContact: number; afterLift: number[] };
		// eslint-disable-next-line no-console
		console.log(`SAVE NO-COMMIT CONTACT: writes during the contact ${r.duringContact}; after the lift ${JSON.stringify(r.afterLift)} ms`);
		expect(r.duringContact, "a save wrote during the contact").toBe(0);
		expect(r.afterLift.length > 0 && r.afterLift[0]! <= 1000, `first write after the lift at ${r.afterLift[0]} ms`).toBe(true);
	} finally {
		await page.close();
	}
}, 120_000);

// A lift that never arrives does not hold the page for ever: it is written by 10 s from its first change, and the
// next real contact holds and releases as any other.
it("a pen whose lift never arrives: the page is written by 10 s from its first change, and the next contact holds and releases", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).saveStall.lostLift(600)) as { capWrite: number | null; capSave: number | null; duringContact: number; afterLift: number[] };
		// eslint-disable-next-line no-console
		console.log(`SAVE LOST LIFT: first save starts ${r.capSave} ms and writes ${r.capWrite} ms after the first change; next contact: writes during it ${r.duringContact}, after its lift ${JSON.stringify(r.afterLift)} ms`);
		// The cap fires at 10 s and the save starts then; its write lands after the save's own reads (36 ms measured).
		// 100 ms is the timer's lateness under load, not a longer bound.
		expect(r.capSave !== null && r.capSave <= 10100, `the first save starts ${r.capSave} ms from the first change`).toBe(true);
		expect(r.duringContact, "a save wrote during the next contact").toBe(0);
		expect(r.afterLift.length > 0 && r.afterLift[0]! <= 1000, `first write after the next lift at ${r.afterLift[0]} ms`).toBe(true);
	} finally {
		await page.close();
	}
}, 120_000);

// The save at the lift carries the stroke that lift commits. The lift's own handlers commit it after the store's
// capture listener has run, so a write started inside that listener would hold the page as it was one stroke earlier.
it("nonstop writing on a growing page: the save at the first lift after 5 s holds the stroke that lift committed", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).saveStall.growingPage(600)) as { lifts: number; boundLift: number; bound: number; boundLiftAt: number; saves: { at: number; lastLift: number; holdsIt: boolean | null }[] };
		// eslint-disable-next-line no-console
		console.log(`SAVE GROWING PAGE: ${r.lifts} lifts; bound at ${r.bound} ms inside the stroke that lifts at ${r.boundLiftAt} ms (lift ${r.boundLift}); saves ${JSON.stringify(r.saves)}`);
		const atLift = r.saves.find(x => x.lastLift === r.boundLift);
		expect(r.saves.filter(x => x.at >= r.bound && x.at < r.boundLiftAt), "a save started inside the stroke that spans the bound").toEqual([]);
		expect(atLift, `no save after lift ${r.boundLift}, the first lift after the bound`).toBeDefined();
		expect(atLift!.holdsIt, `the save at ${atLift!.at} ms, after lift ${r.boundLift}, does not hold that lift's stroke`).toBe(true);
		for (const x of r.saves) expect(x.holdsIt, `the save at ${x.at} ms misses the stroke of lift ${x.lastLift}`).not.toBe(false);
	} finally {
		await page.close();
	}
}, 120_000);
