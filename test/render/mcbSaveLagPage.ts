/**
 * Page half of MCBSaveLag.test.ts. Mounts the MCB EXAM 3 note (its own text, Infinite Canvas on) with its ink loaded through
 * the real PageStore from an in-memory adapter, as main.ts wires the store to the inline ink, and records what the store's saves
 * cost while a pen writes: each save (writePending, start and end), each pause between serializer slices (penPause), every
 * adapter call (ms, bytes) and when it settles, each write's encode, main-thread blocking (a setTimeout(0) chain's gaps over
 * 8 ms, and long tasks), the delay from each pen-down's input timestamp to its handler, each pen-up commit, and a flushPage run
 * with the pen down. Counting only, apart from the park check's pen (see parkPen); nothing else changes what the store or the
 * overlay does.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool } from "../../src/inline/InkOverlay";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { setPenInk } from "../../src/inline/PenInk";
import { PageStore, contentStamp } from "../../src/persistence/PageStore";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

installObsidianDom();
Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isTablet: false, isWin: true });

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const now = () => performance.now();

let rig: any = null;
const ev: any[] = [];
let recording = false;
const push = (e: any) => { if (recording) ev.push({ ph: rig?.phase ?? "mount", ...e }); };

// The measuring in-memory adapter: files and folders in maps, every call timed. A write encodes the string once, as
// Obsidian's write does on the main thread before the file system has it, and records that encode's ms; the string is kept
// as handed over (no disk). Every call settles one task later (a setTimeout(0)), as real I/O completes: an adapter that
// settles in microtasks runs a chain of awaits as one task and merges the save's tail into one block.
const files = new Map<string, string>(), mtimes = new Map<string, number>(), folders = new Set<string>([""]);
let clock = 1_790_000_000_000;
const raw = {
	async exists(p: string) { return files.has(p) || folders.has(p); },
	async read(p: string) { const d = files.get(p); if (d === undefined) throw new Error("ENOENT " + p); return d; },
	async write(p: string, d: string) {
		const t = now();
		const bytes = new TextEncoder().encode(d);
		push({ k: "encode", t, ms: now() - t, len: bytes.length });
		files.set(p, d); mtimes.set(p, (clock += 1000));
	},
	async rename(a: string, b: string) { const d = files.get(a); if (d === undefined) throw new Error("ENOENT " + a); files.set(b, d); mtimes.set(b, mtimes.get(a)!); files.delete(a); mtimes.delete(a); },
	async remove(p: string) { files.delete(p); mtimes.delete(p); },
	async mkdir(p: string) { folders.add(p); },
	async stat(p: string) { return files.has(p) ? { type: "file", ctime: 0, mtime: mtimes.get(p)!, size: files.get(p)!.length } : folders.has(p) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null; },
	async list(p: string) {
		const pre = p ? p.replace(/\/$/, "") + "/" : "";
		const direct = (k: string) => k.startsWith(pre) && k.length > pre.length && !k.slice(pre.length).includes("/");
		return { files: [...files.keys()].filter(direct), folders: [...folders].filter(direct) };
	},
};
const adapter: any = {};
// The park check: when a timer's save moves the live sidecar aside while writing, a pen comes down (a pointerdown on the
// window, where the store watches pens) and stays down PARK_HOLD_MS. The save must not wait for that lift with the live
// file absent; the test reads the time from this rename to rename(tmp, final).
const PARK_PEN = 4242, PARK_HOLD_MS = 500;
const pen = (type: string) => window.dispatchEvent(new PointerEvent(type, { pointerType: "pen", pointerId: PARK_PEN, isPrimary: true, bubbles: true }));
function parkPen(a: any[]) {
	const s = rig?.curSave;
	if (!recording || rig?.phase !== "write" || !s || s.args !== "true" || String(a[0]) !== ".handwriting/" + rig.pageId + ".json") return;
	push({ k: "parkDown", t: now(), save: s.id });
	pen("pointerdown");
	setTimeout(() => { pen("pointerup"); push({ k: "parkUp", t: now(), save: s.id }); }, PARK_HOLD_MS);
}
// Each call and its settling carry one id: the next call often starts in the same millisecond the previous one settled.
let ioSeq = 0;
for (const [name, fn] of Object.entries(raw)) {
	adapter[name] = async (...a: any[]) => {
		const t = now(), id = ++ioSeq;
		if (name === "rename") parkPen(a);
		try { return await (fn as any)(...a); } finally {
			push({ k: "io", op: name, id, t, ms: now() - t, path: String(a[0]).slice(-48), to: name === "rename" ? String(a[1]).slice(-48) : undefined, len: name === "write" ? String(a[1]).length : name === "read" ? (files.get(a[0])?.length ?? -1) : undefined });
			await new Promise<void>(r => setTimeout(r, 0));
			push({ k: "resume", op: name, id, t: now() });
		}
	};
}
const store: any = new PageStore({ vault: { adapter } } as any);

const ids = new Map<string, string>();
let scheduleAsks = 0;
const host: any = {
	readPageId: (p: string) => ids.get(p) ?? null,
	claimId: async (p: string, id: string) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: (id: string) => store.load(id),
	scheduleSidecar: (id: string, page: any) => { scheduleAsks++; push({ k: "sched", t: now() }); store.schedule(id, page); },
	scheduleSidecarNow: (id: string, page: any) => store.saveNow(id, page),
	notify: () => {},
};
if (typeof store.hasQueuedWrite === "function") host.hasQueuedWrite = (id: string) => store.hasQueuedWrite(id);
(inlineInk as any).attachHost(host);

(window as any).mcbSave = {
	async mount(note: string, ink: string, pageId: string, paneW: number, paneH: number, want: number) {
		setDiagnosticsEnabled(false);
		setPenInk(true); setScrollExpansionEnabled(true); setInlineTool("pen");
		const path = "MCB EXAM 3.md";
		folders.add(".handwriting");
		files.set(".handwriting/" + pageId + ".json", ink); mtimes.set(".handwriting/" + pageId + ".json", clock);
		ids.set(path, pageId);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:300px;margin-top:20px;width:" + paneW + "px;height:" + paneH + "px;overflow:hidden";
		const t0 = now();
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: note, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: paneW + "px", height: paneH + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		view.contentDOM.parentElement!.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
		for (let i = 0; i < 400 && inlineInk.strokes(path).length < want; i++) await settle(2);
		const loadMs = now() - t0;
		await settle(12);
		const overlay: any = overlayForPath(path);
		if (!overlay) throw new Error("no overlay");
		rig = { view, overlay, path, pageId, phase: "mount", wraps: [] as any[], saveSeq: 0, curSave: null as any };
		overlay.scheduleRepaint("other");
		await settle(12);
		return { strokes: inlineInk.strokes(path).length, canvasMode: !!overlay.canvasMode, cssScale: overlay.cssScale, dpr: window.devicePixelRatio, loadMs,
			penPause: typeof store.penPause === "function", writePending: typeof store.writePending === "function", files: [...files.keys()] };
	},
	record() {
		const { overlay } = rig;
		const wrap = (o: any, n: string, f: (orig: any) => any) => { const orig = o[n]; if (typeof orig !== "function") return false; rig.wraps.push([o, n, orig, Object.prototype.hasOwnProperty.call(o, n)]); o[n] = f(orig); return true; };
		const probes: Record<string, boolean> = {};
		probes.writePending = wrap(store, "writePending", o => async function (this: any, ...a: any[]) {
			const rec = { k: "save", id: ++rig.saveSeq, t: now(), end: 0, args: a.length > 1 ? String(a[1]) : "" };
			const outer = rig.curSave; rig.curSave = rec;
			try { return await o.apply(this, a); } finally { rec.end = now(); rig.curSave = outer; push(rec); }
		});
		probes.penPause = wrap(store, "penPause", o => function (this: any, ...a: any[]) {
			const pause = o.apply(this, a);
			const save = rig.curSave ? rig.curSave.id : 0;
			push({ k: "pauseMade", t: now(), save });
			return async () => { const t = now(); await pause(); push({ k: "slice", t, res: now(), save }); };
		});
		probes.penUp = wrap(overlay, "penUp", o => function (this: any, ...a: any[]) {
			const t = now();
			try { return o.apply(this, a); } finally { push({ k: "up", t, ms: now() - t }); }
		});
		probes.schedule = true;
		const down = (e: PointerEvent) => { if (e.pointerType === "pen" && e.pointerId !== PARK_PEN) push({ k: "pdown", t: now(), delay: now() - e.timeStamp }); };
		window.addEventListener("pointerdown", down, true);
		rig.unlisten = () => window.removeEventListener("pointerdown", down, true);
		let last = now();
		const tick = () => { if (!recording) return; const t = now(); if (t - last > 8) push({ k: "gap", t, ms: t - last }); last = t; setTimeout(tick, 0); };
		try {
			const obs = new PerformanceObserver(l => { for (const e of l.getEntries()) push({ k: "long", t: e.startTime, ms: e.duration }); });
			obs.observe({ entryTypes: ["longtask"] }); rig.obs = obs; probes.longtask = true;
		} catch { probes.longtask = false; }
		recording = true;
		setTimeout(tick, 0);
		rig.probes = probes;
		return probes;
	},
	phase(name: string) { rig.phase = name; },
	mark(what: string, i: number) { push({ k: "mark", t: now(), what, i }); },
	/** flushPage on the note's page, as a page switch runs it; the pen may be down. */
	async flush() {
		const t = now();
		const ok = await store.flushPage(rig.pageId);
		const ms = now() - t;
		push({ k: "flush", t, ms, ok: !!ok });
		return { ms, ok: !!ok };
	},
	state() { return { strokes: inlineInk.strokes(rig.path).length, scheduleAsks, files: [...files.keys()], sidecarLen: files.get(".handwriting/" + rig.pageId + ".json")?.length ?? -1 }; },
	stop() {
		recording = false;
		try { rig.obs?.disconnect(); } catch { /* none */ }
		rig.unlisten?.();
		for (const [o, n, orig, own] of rig.wraps.reverse()) { if (own) o[n] = orig; else delete o[n]; }
		return { ev, probes: rig.probes, scheduleAsks };
	},
	/**
	 * After stop, with no save in flight: the stamp the store keeps for its own last file against contentStamp of the bytes
	 * that file holds. Unequal, the next save would keep the store's own file as a conflict copy.
	 */
	async check() {
		for (let i = 0; i < 200 && rig.curSave; i++) await new Promise(r => setTimeout(r, 50));
		const text = files.get(".handwriting/" + rig.pageId + ".json");
		return { idle: !rig.curSave, len: text?.length ?? -1, kept: store.knownHash?.get(rig.pageId) ?? null, file: text === undefined ? null : contentStamp(text) };
	},
};
