/**
 * Two synthetic devices: real settings startup/button, migration, PageStore,
 * note/PDF stores, and registered preserving poll. Reuses FakeAdapter and
 * LiveReloadTestHarness. Only transport, metadata, and pane refresh are faked.
 * Refresh snapshots prove notification/content, not pixels or native sync.
 * No direct reload/adopt call is used to make late arrival appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter, gate } from "./persistence/FakeAdapter";
import { InlineInkStore } from "./inline/InlineInkStore";
import { inlineInk } from "./inline/InkOverlay";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { pdfInkId } from "./pdf/PdfIdentity";
import { emptyPage, parsePage, serializePage, type PageData } from "./model/PageData";
import type { InkStroke } from "./ink/Stroke";
import { installLiveReloadPoll } from "./testUtils/LiveReloadTestHarness";
import { transformSync } from "esbuild";
import overlaySource from "./inline/InkOverlay.ts?raw";

// Execute the shipped census/admission functions. Only editor binding metadata
// is reduced here; mounted gesture/selection behavior is covered by the browser fixture.
const overlay = overlaySource.replace(/\r\n/g, "\n");
const candidatesStart = "export interface InlineReloadBinding {";
const candidatesEnd = "/** Zoom diagnostics";
expect(overlay.split(candidatesStart)).toHaveLength(2);
expect(overlay.split(candidatesEnd)).toHaveLength(2);
const candidatesCode = transformSync(overlay.slice(overlay.indexOf(candidatesStart), overlay.indexOf(candidatesEnd)).replace(/^export /gm, ""),
  { loader: "ts", target: "es2022" }).code;
expect(candidatesCode).toContain("reloadBinding()");
type EditorStandIn = ReturnType<typeof editor>;
function productionNoteCandidates(editors: EditorStandIn[]) {
  return new Function("instances", `${candidatesCode}\nreturn {noteCandidates:inlineReloadCandidates,noteAdmission:captureInlineReloadAdmission};`)(editors) as {
    noteCandidates:()=>string[]; noteAdmission:(path:string)=>(()=>boolean)|null;
  };
}
function editor(path: string, busy = false) {
  return { path, busy, selected:false, attached:true, attachment:{}, file:{path}, editor:{}, epoch:0,
    reloadBinding() { return this.attached ? {pane:this,attachment:this.attachment,file:this.file,editor:this.editor,
      path:this.path,epoch:this.epoch,quiet:!this.busy&&!this.selected} : null; } };
}
const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", async original => ({ ...await original<object>(), Notice: class {
  constructor(message: string) { notices.push(message); }
} }));

class SyncAdapter extends FakeAdapter {
  failList = false;
  async list(path: string) {
    if (this.failList) throw new Error("injected list failure");
    const prefix = path + "/";
    return { files: [...this.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")),
      folders: [...this.dirs].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) };
  }
}
const notePath = "Synthetic.md", noteId = "synthetic-note";
let pdfId: string;
function stroke(id: string): InkStroke {
  return { id, tool: "pen", color: "#123456", width: 2, createdAt: 1,
    points: [{ x: 10, y: 20, pressure: .5, t: 0 }, { x: 30, y: 40, pressure: .7, t: 10 }],
    bbox: { x: 10, y: 20, width: 20, height: 20 } };
}
function page(id: string, surface: "inline" | "pdf", ids: string[]) {
  return { ...emptyPage(id), surface, strokes: ids.map(name => ({ ...stroke(name), ...(surface === "pdf" ? { page: 1 } : {}) })) };
}
function seed(adapter: SyncAdapter, folder = ".handwriting", suffix = "original") {
  adapter.dirs.add(folder);
  adapter.externalWrite(`${folder}/${noteId}.json`, serializePage(page(noteId, "inline", [`note-${suffix}`])));
  adapter.externalWrite(`${folder}/${pdfId}.json`, serializePage(page(pdfId, "pdf", [`pdf-${suffix}`])));
}
function documents(adapter: SyncAdapter) {
  adapter.externalWrite(notePath, `---\nhandwriting-page-id: ${noteId}\n---\nSynthetic text`);
  adapter.externalWrite("Synthetic.pdf", "%PDF-1.4 synthetic identity fixture");
}
async function device(adapter = new SyncAdapter(), raw: unknown = {}, beforeLoad?: (store: PageStore) => void) {
  // Same prototype harness as SettingsUnknownKeys; actual store collaborators.
  const plugin = Object.create(HandwritingPlugin.prototype) as any;
  const store = new PageStore({ vault: { adapter } } as never);
  const pdf = new PdfInkStore();
  let saved: unknown = null;
  Object.assign(plugin, { store, pdfStore: pdf, settingsTimer: null, settingsDirty: false,
    settingsWriting: null, settingsWriteAgain: false,
    app: { vault: { adapter }, workspace: { onLayoutReady() {} } },
    loadData: async () => raw, saveData: async (value: unknown) => { saved = structuredClone(value); },
    applyPaperTo() {}, applyBooxMode() {} });
  beforeLoad?.(store);
  await plugin.loadSettings();
  const ink = new InlineInkStore();
  ink.attachHost({
    readPageId: path => adapter.files.get(path)?.match(/handwriting-page-id: ([^\n]+)/)?.[1] ?? null,
    claimId: async () => ({ pageId: noteId }), loadSidecar: id => store.load(id),
    scheduleSidecar: (id, data) => store.schedule(id, data), scheduleSidecarNow: (id, data) => store.saveNow(id, data),
    prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing),
    acceptExternalAdoption: prepared => store.acceptExternalAdoption(prepared), notify() {},
  });
  async function open() { await ink.ensureLoaded(notePath); await pdf.ensureLoaded(pdfId); }
  async function clickCompatibility() {
    let clicked!: () => void, pending = Promise.resolve();
    const labels: string[] = [];
    const tab = Object.create(HandwritingSettingTab.prototype) as any;
    tab.plugin = plugin;
    const real = plugin.changeInkFolder.bind(plugin);
    plugin.changeInkFolder = (target: string) => (pending = real(target));
    const button = { setButtonText(v: string) { labels.push(v); return this; }, setCta() { return this; },
      setDisabled() { return this; }, onClick(fn: () => void) { clicked = fn; return this; } };
    const setting = { setName() { return this; }, addButton(fn: (b: typeof button) => void) { fn(button); return this; } };
    tab.renderSyncButton(setting);
    clicked(); await pending; await plugin.persistSettings();
    plugin.changeInkFolder = real;
    return labels;
  }
  return { adapter, plugin, store, ink, pdf, open, clickCompatibility, saved: () => saved };
}
type Device = Awaited<ReturnType<typeof device>>;
// `noteCandidates` stands in for InkOverlay's inlineReloadCandidates (a path is
// listed when any editor on it reports reloadCandidatePath); `pdfPanes` opens
// that many PDF panes on the one document, as a split view does.
function poll(d: Device, opts: { noteCandidates?: () => string[]; noteAdmission?: (path:string)=>(()=>boolean)|null; notePanes?: number; pdfPanes?: number } = {}) {
  let callback!: () => void, pending = Promise.resolve();
  const errors: unknown[] = [];
  let notePaint = d.ink.strokes(notePath).map(s => s.id), noteNotifications = 0;
  const notePaints=Array.from({length:opts.notePanes??1},()=>[...notePaint]);
  const candidates=opts.noteCandidates??(()=>[notePath]);
  const panes = Array.from({ length: opts.pdfPanes ?? 1 }, () => ({ idle: true, painted: d.pdf.strokes(pdfId).map(s => s.id),
    refresh() { this.painted = d.pdf.strokes(pdfId).map(s => s.id); } }));
  const roots = panes.map(() => ({ isConnected: true }));
  const state = { store: d.store, pdfStore: d.pdf, pdfInk: new Map(roots.map((root, i) => [root, panes[i]!])),
    pdfIds: new Map(roots.map(root => [root, pdfId])),
    pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 }, registerInterval() {} };
  installLiveReloadPoll.call(state, { setInterval(fn: () => void) { callback = fn; return 1; } }, { hidden: false },
    (p: Promise<void>) => { pending = p; }, candidates, d.ink,
    () => { noteNotifications++; }, () => { notePaint = d.ink.strokes(notePath).map(s => s.id); notePaints.forEach((_,i)=>notePaints[i]=[...notePaint]); },
    () => null, async () => false, { error: (...args: unknown[]) => errors.push(args) },
    opts.noteAdmission ?? ((path:string) => () => candidates().includes(path)));
  return { pane: panes[0]!, panes, errors, notePaints, noteNotifications:()=>noteNotifications, notePaint: () => notePaint, async tick() { callback(); await pending; } };
}
function transfer(from: SyncAdapter, to: SyncAdapter) {
  // A synthetic transport carries visible paths, not .handwriting or settings.
  for (const [path, bytes] of from.files) if (path.startsWith("handwriting/")) {
    to.dirs.add("handwriting"); to.externalWrite(path, bytes);
  }
}
function ids(d: Device) { return [d.ink.strokes(notePath).map(s => s.id), d.pdf.strokes(pdfId).map(s => s.id)]; }
function sameMtimeReplacement(files: SyncAdapter) {
  const previous = new Map(files.mtimes);
  seed(files, "handwriting", "incoming");
  for (const id of [noteId, pdfId]) {
    const path = `handwriting/${id}.json`; files.mtimes.set(path, previous.get(path)!);
  }
}
async function pollThroughBackoff(p: ReturnType<typeof poll>) { for (let i = 0; i < 5; i++) await p.tick(); }
async function editAndReopen(d: Device) {
  d.ink.commit(notePath, stroke("note-later"));
  d.pdf.replaceAllLive(pdfId, [...d.pdf.strokes(pdfId), { ...stroke("pdf-later"), page: 1 }]);
  d.pdf.save(pdfId);
  await d.ink.settle(); await d.store.flush();
  const cold = await device(d.adapter, { inkFolder: "handwriting" }); await cold.open();
  expect(ids(cold)).toEqual([["note-original", "note-later"], ["pdf-original", "pdf-later"]]);
  for (const id of [noteId, pdfId]) expect([...d.adapter.files.keys()].filter(p => p.endsWith(`/${id}.json`))).toEqual([`handwriting/${id}.json`]);
}
beforeEach(async () => {
  notices.length = 0;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { body: { classList: { add() {}, toggle() {}, contains: () => false } } });
  pdfId = await pdfInkId(new TextEncoder().encode("%PDF-1.4 synthetic identity fixture"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("compatibility across two synthetic devices", () => {
  it("same-mtime verification bounds quiet reads per loaded page and discovers replacements at the next due check", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const files = new SyncAdapter(); documents(files); seed(files, "handwriting");
    const d = await device(files, { inkFolder: "handwriting" }); await d.open(); const p = poll(d);
    const reads = vi.spyOn(files, "read");
    await pollThroughBackoff(p); expect(reads).toHaveBeenCalledTimes(2);
    sameMtimeReplacement(files); now = 4999;
    await pollThroughBackoff(p); expect(reads).toHaveBeenCalledTimes(2);
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    now = 5000; await pollThroughBackoff(p);
    expect(ids(d)).toEqual([["note-incoming"], ["pdf-incoming"]]);
    reads.mockClear(); await pollThroughBackoff(p); expect(reads).not.toHaveBeenCalled();
    now = 10000; await pollThroughBackoff(p); expect(reads).toHaveBeenCalledTimes(2);
  });
  it.each(["stat", "read", "preservation", "future", "damaged"])("same-mtime %s failure retains old ink and retries without accepting the incoming baseline", async failure => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const files = new SyncAdapter(); documents(files); seed(files, "handwriting");
    const d = await device(files, { inkFolder: "handwriting" }); await d.open(); const p = poll(d);
    sameMtimeReplacement(files);
    const paths = [noteId, pdfId].map(id => `handwriting/${id}.json`);
    const incoming = paths.map(path => files.files.get(path)!);
    let broken = true;
    if (failure === "stat") {
      const stat = files.stat.bind(files); vi.spyOn(files, "stat").mockImplementation(path => broken ? Promise.reject(new Error("stat failed")) : stat(path));
    } else if (failure === "read") {
      const read = files.read.bind(files); vi.spyOn(files, "read").mockImplementation(path => broken && paths.includes(path) ? Promise.reject(new Error("read failed")) : read(path));
    } else if (failure === "preservation") files.failWriteTimes = 2;
    else paths.forEach((path, i) => files.files.set(path, failure === "damaged" ? "{" : JSON.stringify({ ...JSON.parse(incoming[i]!), schemaVersion: 999 })));
    await p.tick();
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    expect(p.notePaint()).toEqual(["note-original"]); expect(p.pane.painted).toEqual(["pdf-original"]);
    broken = false; files.failWriteTimes = 0;
    paths.forEach((path, i) => files.files.set(path, incoming[i]!));
    now = 5000; await pollThroughBackoff(p);
    expect(ids(d)).toEqual([["note-incoming"], ["pdf-incoming"]]);
    expect(p.notePaint()).toEqual(["note-incoming"]); expect(p.pane.painted).toEqual(["pdf-incoming"]);
  });
  it.each([false, true])("same-mtime arrival preserves queued local edits with a read already in flight=%s", async inFlight => {
    const files = new SyncAdapter(); documents(files); seed(files, "handwriting");
    const d = await device(files, { inkFolder: "handwriting" }); await d.open(); const p = poll(d);
    sameMtimeReplacement(files);
    const entered = gate(), release = gate(); const read = files.read.bind(files);
    if (inFlight) vi.spyOn(files, "read").mockImplementation(async path => { entered.release(); await release.promise; return read(path); });
    const ticking = inFlight ? p.tick() : null;
    if (inFlight) await entered.promise;
    d.ink.commit(notePath, stroke("local-note"));
    d.pdf.replaceAllLive(pdfId, [...d.pdf.strokes(pdfId), { ...stroke("local-pdf"), page: 1 }]); d.pdf.save(pdfId);
    release.release(); if (ticking) await ticking; else await p.tick();
    expect(ids(d)).toEqual([["note-original", "local-note"], ["pdf-original", "local-pdf"]]);
    await d.ink.settle(); await d.store.flush();
    const bytes = [...files.files.values()].join("\n");
    for (const id of ["note-incoming", "pdf-incoming", "local-note", "local-pdf"]) expect(bytes).toContain(id);
  });
  it.each(["same", "advancing"])("audit existing sidecar replacement with %s mtime reaches note and PDF through the registered poll", async timing => {
    const files = new SyncAdapter(); documents(files); seed(files, "handwriting");
    const d = await device(files, { inkFolder: "handwriting" }); await d.open();
    const p = poll(d);
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    const paths = [noteId, pdfId].map(id => `handwriting/${id}.json`);
    const before = paths.map(path => ({ bytes: files.files.get(path)!, mtime: files.mtimes.get(path)! }));
    seed(files, "handwriting", "incoming");
    for (const [i, path] of paths.entries()) {
      if (timing === "same") files.mtimes.set(path, before[i]!.mtime);
      expect(files.files.get(path)).not.toBe(before[i]!.bytes);
      expect(files.files.get(path)!.length).toBe(before[i]!.bytes.length);
      expect(files.mtimes.get(path) === before[i]!.mtime).toBe(timing === "same");
    }
    const reads = vi.spyOn(files, "read");
    await p.tick(); await p.tick(); await p.tick();
    expect(p.errors).toEqual([]);
    expect.soft(reads.mock.calls.filter(([path]) => paths.includes(path)).length, "delivered sidecar content must be checked").toBeGreaterThan(0);
    expect.soft(p.notePaint()).toEqual(["note-incoming"]);
    expect.soft(p.pane.painted).toEqual(["pdf-incoming"]);
    expect.soft(ids(d)).toEqual([["note-incoming"], ["pdf-incoming"]]);
    // Cold load sees delivered bytes: the failure is discovery/adoption, not transport.
    const cold = await device(files, { inkFolder: "handwriting" }); await cold.open();
    expect(ids(cold)).toEqual([["note-incoming"], ["pdf-incoming"]]);
  });
  it("normal computer-first/tablet-second button flow migrates both surfaces and cold reopens after edits", async () => {
    const computer = await device(); documents(computer.adapter);
    expect((await computer.clickCompatibility())[0]).toBe("Turn on");
    const files = new SyncAdapter(); documents(files); seed(files);
    const tablet = await device(files); await tablet.open();
    expect(ids(tablet)).toEqual([["note-original"], ["pdf-original"]]);
    expect((await tablet.clickCompatibility())[0]).toBe("Turn on");
    transfer(files, computer.adapter); await computer.open();
    expect(ids(computer)).toEqual(ids(tablet));
    await editAndReopen(computer);
  });
  it("settings arriving before tablet startup migrate existing hidden note and PDF ink", async () => {
    const files = new SyncAdapter(); documents(files); seed(files);
    const tablet = await device(files, { inkFolder: "handwriting" }); await tablet.open();
    expect(ids(tablet)).toEqual([["note-original"], ["pdf-original"]]);
    for (const id of [noteId, pdfId]) expect.soft(files.files.has(`handwriting/${id}.json`)).toBe(true);
    await editAndReopen(tablet);
  });
  it.each([null, { inkFolder: ".handwriting" }])("startup with %j does not invent a compatibility choice", async raw => {
    const files = new SyncAdapter(); documents(files); seed(files);
    const tablet = await device(files, raw); await tablet.open();
    expect(tablet.plugin.settings.inkFolder).toBe(".handwriting");
    expect(files.files.has(`.handwriting/${noteId}.json`)).toBe(true);
    expect((await tablet.clickCompatibility())[0]).toBe("Turn on");
    expect(files.files.has(`handwriting/${noteId}.json`)).toBe(true);
  });
  it("an already-equal explicit change is a no-op, while the actual enabled button turns off", async () => {
    const files = new SyncAdapter(); documents(files); seed(files, "handwriting");
    const d = await device(files, { inkFolder: "handwriting" });
    const before = [...files.files]; await d.plugin.changeInkFolder("handwriting");
    expect([...files.files]).toEqual(before);
    expect((await d.clickCompatibility())[0]).toBe("Turn off");
    expect(d.store.inkFolder()).toBe(".handwriting");
  });
  it("JSON arriving after empty initial open appears through the registered poll without drawing or reopening", async () => {
    const files = new SyncAdapter(); documents(files);
    const d = await device(files, { inkFolder: "handwriting" }); await d.open();
    const p = poll(d); expect(ids(d)).toEqual([[], []]);
    await p.tick(); seed(files, "handwriting"); await p.tick();
    expect(p.errors).toEqual([]);
    expect.soft(p.notePaint()).toEqual(["note-original"]); expect.soft(p.pane.painted).toEqual(["pdf-original"]);
    await editAndReopen(d);
  });
  it("startup collision retains different source bytes as recovery and leaves the destination unchanged", async () => {
    const files = new SyncAdapter(); documents(files); seed(files); seed(files, "handwriting", "remote");
    const before = new Map(files.files);
    const d = await device(files, { inkFolder: "handwriting" }); await d.open();
    for (const id of [noteId, pdfId]) {
      expect(files.files.get(`handwriting/${id}.json`)).toBe(before.get(`handwriting/${id}.json`));
      expect(files.files.has(`.handwriting/${id}.json`)).toBe(false);
      const recovery = [...files.files].filter(([path]) => path.startsWith(`handwriting/${id}.conflict-migration-`));
      expect(recovery).toHaveLength(1);
      expect(recovery[0]![1]).toBe(before.get(`.handwriting/${id}.json`));
    }
    expect(notices.some(n => n.includes("conflicting ink was kept in recovery files"))).toBe(true);
    expect(ids(d)).toEqual([["note-remote"], ["pdf-remote"]]);
  });
  it.each(["list", "rename"])("startup %s failure keeps bytes and retries migration on later startup", async failure => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const files = new SyncAdapter(); documents(files); seed(files);
    if (failure === "list") files.failList = true; else files.failRenameTimes = 1;
    const before = [...files.files];
    const d = await device(files, { inkFolder: "handwriting" }); await d.open();
    expect([...files.files]).toEqual(before);
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    expect(notices.some(n => n.includes("Reload Handwriting to retry"))).toBe(true);
    files.failList = false;
    const retried = await device(files, { inkFolder: "handwriting" }); await retried.open();
    await editAndReopen(retried);
  });
  it("a later startup never republishes a retained collision after the visible sidecar is removed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const files = new SyncAdapter(); documents(files); seed(files); seed(files, "handwriting", "remote");
    files.externalWrite(`.handwriting/${noteId}.json.tmp`, serializePage(page(noteId, "inline", ["interrupted-ink"])));
    const oldRecovery = `handwriting/${noteId}.conflict-migration-42.json`;
    files.externalWrite(oldRecovery, "previous recovery bytes");
    await device(files, { inkFolder: "handwriting" });
    for (const id of [noteId, pdfId]) files.files.delete(`handwriting/${id}.json`);
    const unseen = serializePage(page("unseen", "inline", ["unseen-ink"]));
    files.externalWrite(".handwriting/unseen.json", unseen);
    await device(files, { inkFolder: "handwriting" }); // no document open or fallback read
    for (const id of [noteId, pdfId]) expect.soft(files.files.has(`handwriting/${id}.json`)).toBe(false);
    expect(files.files.has(`handwriting/${noteId}.json.tmp`)).toBe(false);
    expect(files.files.get(oldRecovery)).toBe("previous recovery bytes");
    const bytes = [...files.files.values()].join("\n");
    expect(bytes).toContain("note-original"); expect(bytes).toContain("pdf-original");
    expect(bytes).toContain("interrupted-ink");
    expect(files.files.get("handwriting/unseen.json")).toBe(unseen);
  });
  it("failed collision preservation leaves both revisions intact and retries without claiming success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const files = new SyncAdapter(); documents(files); seed(files); seed(files, "handwriting", "remote");
    const before = [...files.files]; files.failRenameTimes = 1;
    await device(files, { inkFolder: "handwriting" });
    expect([...files.files]).toEqual(before);
    expect(notices.some(n => n.includes("conflicting ink was kept in recovery files"))).toBe(false);
    await device(files, { inkFolder: "handwriting" });
    expect(notices.some(n => n.includes("conflicting ink was kept in recovery files"))).toBe(true);
    for (const id of [noteId, pdfId]) {
      expect(files.files.has(`.handwriting/${id}.json`)).toBe(false);
      expect(files.files.get(`handwriting/${id}.json`)).toContain("remote");
    }
    const bytes = [...files.files.values()].join("\n");
    expect(bytes).toContain("note-original"); expect(bytes).toContain("pdf-original");
  });
  it("queued ink during startup migration lands at the destination after repoint", async () => {
    const files = new SyncAdapter(); documents(files); seed(files);
    const entered = gate(), release = gate();
    const rename = files.rename.bind(files);
    vi.spyOn(files, "rename").mockImplementation(async (a, b) => { entered.release(); await release.promise; return rename(a, b); });
    let store!: PageStore;
    const loading = device(files, { inkFolder: "handwriting" }, value => { store = value; });
    await entered.promise;
    store.schedule(noteId, page(noteId, "inline", ["note-original", "during-move"]));
    await store.flush(); // held, requeued rather than discarded or written behind the move
    release.release(); await loading; await store.flush();
    expect(files.files.has(`.handwriting/${noteId}.json`)).toBe(false);
    expect(parsePage(files.files.get(`handwriting/${noteId}.json`)!, noteId).data.strokes.map(s => s.id)).toEqual(["note-original", "during-move"]);
  });
  it("busy ordinary toggle refuses migration and leaves the requested choice unchanged", async () => {
    const files = new SyncAdapter(); documents(files); seed(files);
    const d = await device(files);
    vi.spyOn(inlineInk, "settle").mockResolvedValueOnce(false);
    await d.clickCompatibility();
    expect(d.plugin.settings.inkFolder).toBe(".handwriting");
    expect(files.files.has(`.handwriting/${noteId}.json`)).toBe(true);
    expect(files.files.has(`handwriting/${noteId}.json`)).toBe(false);
  });
  it("never-opened IDs remain unpolled; an opened missing page does not trigger a missing-ink notice", async () => {
    const d = await device(); documents(d.adapter);
    const reads = vi.spyOn(d.adapter, "read");
    expect(await d.store.externallyChanged("unopened")).toBe(false);
    expect(reads).not.toHaveBeenCalled();
    await d.open(); const p = poll(d); await p.tick();
    expect(d.store.externalChangeObservation(noteId)).toBe("unchanged");
    expect(notices).toEqual([]);
  });
  // No "preservation" case here: these surfaces start empty, so the late
  // revision only adds and no recovery pair is written - there is no write to
  // fail. Preservation failures on revisions that diverge are held and retried
  // in PdfAdoptionRouteEndToEnd.test.ts and InlineExternalAdoptionPreservation.test.ts.
  it.each(["damaged", "future"])("late %s input stays retryable without consuming either surface", async failure => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const files = new SyncAdapter(); documents(files);
    const d = await device(files, { inkFolder: "handwriting" }); await d.open(); const p = poll(d);
    seed(files, "handwriting");
    if (failure === "preservation") files.failWriteTimes = 2;
    else for (const id of [noteId, pdfId]) {
      const path = `handwriting/${id}.json`;
      files.externalWrite(path, failure === "damaged" ? "{" : JSON.stringify({ ...JSON.parse(files.files.get(path)!), schemaVersion: 999 }));
    }
    const before = [files.files.get(`handwriting/${noteId}.json`), files.files.get(`handwriting/${pdfId}.json`)];
    await p.tick();
    expect(ids(d)).toEqual([[], []]); expect(p.notePaint()).toEqual([]); expect(p.pane.painted).toEqual([]);
    expect([files.files.get(`handwriting/${noteId}.json`), files.files.get(`handwriting/${pdfId}.json`)]).toEqual(before);
    files.failWriteTimes = 0; seed(files, "handwriting"); await p.tick();
    expect(p.notePaint()).toEqual(["note-original"]); expect(p.pane.painted).toEqual(["pdf-original"]);
  });
  it("local ink queued before arrival blocks adoption and preserves both revisions after flush", async () => {
    const files = new SyncAdapter(); documents(files);
    const d = await device(files, { inkFolder: "handwriting" }); await d.open(); const p = poll(d);
    d.ink.commit(notePath, stroke("local-note"));
    d.pdf.replaceAllLive(pdfId, [{ ...stroke("local-pdf"), page: 1 }]); d.pdf.save(pdfId);
    seed(files, "handwriting"); await p.tick();
    expect(ids(d)).toEqual([["local-note"], ["local-pdf"]]);
    await d.ink.settle(); await d.store.flush();
    const allBytes = [...files.files.values()].join("\n");
    for (const name of ["local-note", "local-pdf", "note-original", "pdf-original"]) expect(allBytes).toContain(name);
    for (const id of [noteId, pdfId]) expect([...files.files.keys()].filter(path => path.endsWith(`/${id}.json`))).toHaveLength(1);
  });
});

/**
 * 1.4.20 sync regimes for an ALREADY-OPEN note and PDF whose sidecar is replaced
 * underneath them (Syncthing replaces whole files, sometimes at the same mtime).
 * Every case ends the same way: settle, flush, then a cold device on the same
 * bytes. The outcome asserted is ink in the live model, on disk, and after
 * reopen; nothing asserts that a code path was entered. Synthetic geometry
 * only. Limits: pane refresh and the inline candidate list are stand-ins (see
 * `poll`), so the inline gesture gate itself (InkOverlay.reloadCandidatePath)
 * is not executed here; transport is an in-memory adapter, not a sync service.
 */
describe("sync regimes through save and cold reopen", () => {
  // Read lazily: pdfId is assigned in beforeEach.
  const both = () => [[noteId, "note"], [pdfId, "pdf"]] as const;
  function replace(files: SyncAdapter, timing: "same" | "advancing") {
    if (timing === "same") sameMtimeReplacement(files); else seed(files, "handwriting", "incoming");
  }
  function localEdit(d: Device, name: string) {
    d.ink.commit(notePath, stroke(`note-${name}`));
    d.pdf.replaceAllLive(pdfId, [...d.pdf.strokes(pdfId), { ...stroke(`pdf-${name}`), page: 1 }]);
    d.pdf.save(pdfId);
  }
  async function reopen(d: Device) {
    await d.ink.settle(); await d.store.flush();
    const cold = await device(d.adapter, { inkFolder: "handwriting" }); await cold.open();
    return cold;
  }
  function onlyLive(files: SyncAdapter) {
    for (const [id] of both()) expect([...files.files.keys()].filter(p => p.endsWith(`/${id}.json`))).toEqual([`handwriting/${id}.json`]);
  }
  function kept(files: SyncAdapter, id: string, strokeId: string) {
    return [...files.files].filter(([p, b]) => p.startsWith(`handwriting/${id}.conflict-`) && b.includes(`"${strokeId}"`)).length;
  }
  async function start(timingClock = { now: 0 }) {
    vi.spyOn(performance, "now").mockImplementation(() => timingClock.now);
    const files = new SyncAdapter(); documents(files); seed(files, "handwriting");
    const d = await device(files, { inkFolder: "handwriting" }); await d.open();
    return { files, d, clock: timingClock };
  }

  it.each(["advancing", "same"] as const)("(i) quiet pane, %s mtime: both surfaces adopt, keep the outgoing revision, and survive edit and cold reopen", async timing => {
    const { files, d, clock } = await start(); const p = poll(d);
    await pollThroughBackoff(p);
    replace(files, timing); clock.now = 5000; await pollThroughBackoff(p);
    expect(p.errors).toEqual([]);
    expect(ids(d)).toEqual([["note-incoming"], ["pdf-incoming"]]);
    expect(p.notePaint()).toEqual(["note-incoming"]); expect(p.pane.painted).toEqual(["pdf-incoming"]);
    for (const [id, s] of both()) expect(kept(files, id, `${s}-original`), `${s} outgoing revision kept on disk`).toBeGreaterThan(0);
    localEdit(d, "later");
    const cold = await reopen(d);
    expect(ids(cold)).toEqual([["note-incoming", "note-later"], ["pdf-incoming", "pdf-later"]]);
    expect(ids(d)).toEqual(ids(cold));
    onlyLive(files);
  });

  it.each(["advancing", "same"] as const)("(ii-a) dirty pane, %s mtime: queued local ink stays live, incoming is kept, model equals reopen", async timing => {
    const { files, d, clock } = await start(); const p = poll(d);
    await pollThroughBackoff(p);
    localEdit(d, "local");
    replace(files, timing); clock.now = 5000; await p.tick();
    expect(ids(d)).toEqual([["note-original", "note-local"], ["pdf-original", "pdf-local"]]);
    await d.ink.settle(); await d.store.flush();
    clock.now = 10000; await pollThroughBackoff(p);
    const cold = await reopen(d);
    expect(ids(cold)).toEqual([["note-original", "note-local"], ["pdf-original", "pdf-local"]]);
    expect(ids(d), "live model must match what reopens").toEqual(ids(cold));
    for (const [id, s] of both()) expect(kept(files, id, `${s}-incoming`), `${s} incoming revision kept on disk`).toBeGreaterThan(0);
    onlyLive(files);
  });

  it("(ii-b) gesture active: adoption waits for pen-up; the gesture's result lands and the incoming revision is kept", async () => {
    const { files, d, clock } = await start();
    let gesture = false;
    const p = poll(d, { noteCandidates: () => gesture ? [] : [notePath] });
    await pollThroughBackoff(p);
    gesture = true; p.pane.idle = false;
    replace(files, "advancing"); clock.now = 5000; await pollThroughBackoff(p); await pollThroughBackoff(p);
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    expect(p.pane.painted).toEqual(["pdf-original"]);
    gesture = false; p.pane.idle = true; localEdit(d, "gesture");
    await d.ink.settle(); await d.store.flush();
    clock.now = 10000; await pollThroughBackoff(p);
    const cold = await reopen(d);
    expect(ids(cold)).toEqual([["note-original", "note-gesture"], ["pdf-original", "pdf-gesture"]]);
    expect(ids(d)).toEqual(ids(cold));
    for (const [id, s] of both()) expect(kept(files, id, `${s}-incoming`), `${s} incoming revision kept on disk`).toBeGreaterThan(0);
    onlyLive(files);
  });

  it("(iii-a) both panes hold while a sibling is mid-gesture, then converge without a local edit", async () => {
    const { files, d, clock } = await start();
    const notePanes = [editor(notePath, true), editor(notePath, false)];
    const p = poll(d, { pdfPanes:2, notePanes:2, ...productionNoteCandidates(notePanes) });
    await pollThroughBackoff(p); p.panes[1]!.idle = false;
    replace(files, "advancing"); clock.now = 5000;
    await pollThroughBackoff(p); await pollThroughBackoff(p);
    expect(ids(d), "one quiet sibling cannot admit either shared document").toEqual([["note-original"],["pdf-original"]]);
    expect(p.noteNotifications()).toBe(0);
    expect(p.notePaints).toEqual([["note-original"],["note-original"]]);
    expect(p.panes.map(pane=>pane.painted)).toEqual([["pdf-original"],["pdf-original"]]);
    expect(await d.store.externallyChanged(noteId), "held incoming baseline stays unaccepted").toBe(true);
    notePanes[0]!.busy=false; p.panes[1]!.idle=true;
    clock.now=10000; await pollThroughBackoff(p);
    expect(ids(d)).toEqual([["note-incoming"],["pdf-incoming"]]);
    expect(p.notePaints).toEqual([["note-incoming"],["note-incoming"]]);
    expect(p.panes.map(pane=>pane.painted)).toEqual([["pdf-incoming"],["pdf-incoming"]]);
    expect(p.noteNotifications()).toBe(1);
    expect(ids(await reopen(d))).toEqual(ids(d));
    for(const [id,surface] of both()) expect(kept(files,id,`${surface}-original`)).toBeGreaterThan(0);
    onlyLive(files);
  });

  it.each(["pen", "selection"])("stat-await rechecks a sibling's %s before preservation", async change => {
    const {files,d,clock}=await start(), notePanes=[editor(notePath),editor(notePath)];
    const p=poll(d,{notePanes:2,...productionNoteCandidates(notePanes)});
    await pollThroughBackoff(p);replace(files,"advancing");clock.now=5000;
    const entered=gate(),release=gate(),stat=files.stat.bind(files);let held=false;
    vi.spyOn(files,"stat").mockImplementation(async path=>{
      if(!held&&path===`handwriting/${noteId}.json`){held=true;entered.release();await release.promise;}
      return stat(path);
    });
    const adoption=vi.spyOn(d.ink,"adoptExternal");
    let ticking=Promise.resolve();
    for(let i=0;i<12&&!held;i++){ticking=p.tick();await Promise.race([ticking,entered.promise]);}
    expect(held).toBe(true);
    if(change==="pen")notePanes[1]!.busy=true;else notePanes[1]!.selected=true;
    release.release();await ticking;
    expect(adoption).not.toHaveBeenCalled();expect(p.noteNotifications()).toBe(0);
    expect(ids(d)[0]).toEqual(["note-original"]);
    expect(await d.store.externallyChanged(noteId)).toBe(true);
    notePanes[1]!.busy=false;notePanes[1]!.selected=false;
    clock.now=10000;await pollThroughBackoff(p);
    expect(p.notePaints).toEqual([["note-incoming"],["note-incoming"]]);
    expect(p.errors).toEqual([]);
  });

  it.each(["pen", "selection", "join", "switch", "retire", "replace", "epoch", "page-id", "queued-write"])("preservation-await requalifies %s before accepting the baseline or notifying", async change => {
    const {files,d,clock}=await start(), notePanes=[editor(notePath),editor(notePath)];
    const p=poll(d,{notePanes:2,...productionNoteCandidates(notePanes)});
    await pollThroughBackoff(p);replace(files,"advancing");clock.now=5000;
    const entered=gate(),release=gate(),write=files.write.bind(files);let held=false;
    vi.spyOn(files,"write").mockImplementation(async(path,data)=>{
      if(!held&&path.startsWith(`handwriting/${noteId}.conflict-external-`)){held=true;entered.release();await release.promise;}
      return write(path,data);
    });
    let ticking=Promise.resolve();
    for(let i=0;i<12&&!held;i++){ticking=p.tick();await Promise.race([ticking,entered.promise]);}
    expect(held,"real preservation write reached").toBe(true);
    const sibling=notePanes[1]!;
    const pageId=vi.spyOn(d.ink,"pageIdOf");
    if(change==="pen")sibling.busy=true;
    if(change==="selection")sibling.selected=true;
    if(change==="join")notePanes.push(editor(notePath));
    if(change==="switch")sibling.path="Other.md";
    if(change==="retire")sibling.attached=false;
    if(change==="replace")sibling.editor={};
    if(change==="epoch")sibling.epoch++;
    if(change==="page-id")pageId.mockReturnValue("rebound-note-id");
    if(change==="queued-write")d.store.schedule(noteId,page(noteId,"inline",["note-original"]));
    release.release();await ticking;
    expect(ids(d)[0],"uncommitted gesture/binding change cannot swap shared ink").toEqual(["note-original"]);
    expect(p.noteNotifications()).toBe(0);expect(p.notePaints).toEqual([["note-original"],["note-original"]]);
    expect(notices).toEqual([]);
    if(change==="queued-write"){
      expect(d.store.hasQueuedWrite(noteId)).toBe(true);
      await d.store.flush();
      // The drained local write is its own revision. The next delivered current
      // remote revision is adopted by the same poll, never a recovery copy.
      replace(files,"advancing");
    }else expect(await d.store.externallyChanged(noteId),"hold does not accept incoming baseline").toBe(true);
    pageId.mockRestore();
    sibling.busy=false;sibling.selected=false;sibling.path=notePath;sibling.attached=true;
    clock.now=10000;await pollThroughBackoff(p);
    expect(p.notePaints).toEqual([["note-incoming"],["note-incoming"]]);expect(p.noteNotifications()).toBe(1);
    expect(p.errors).toEqual([]);
  });

  it("(iii-b) a note commit landing while adoption preservation is awaiting is neither dropped nor overwritten", async () => {
    // Stand-in: panes on one note share one InlineInkStore record, so a second
    // pane's pen-up is modelled as a direct d.ink.commit during the held
    // conflict-external write. No second overlay is mounted.
    const { files, d } = await start();
    const p = poll(d);
    await pollThroughBackoff(p);
    replace(files, "advancing");
    const entered = gate(), release = gate(); const write = files.write.bind(files);
    let held = false;
    vi.spyOn(files, "write").mockImplementation(async (path, data) => {
      if (!held && path.startsWith(`handwriting/${noteId}.conflict-external-`)) { held = true; entered.release(); await release.promise; }
      return write(path, data);
    });
    let ticking: Promise<void> = Promise.resolve();
    for (let i = 0; i < 12 && !held; i++) { ticking = p.tick(); await Promise.race([ticking, entered.promise]); }
    expect(held, "adoption reached preservation").toBe(true);
    d.ink.commit(notePath, stroke("note-otherpane"));
    release.release(); await ticking;
    await d.ink.settle(); await d.store.flush();
    await pollThroughBackoff(p);
    d.ink.commit(notePath, stroke("note-after"));
    const cold = await reopen(d);
    expect(ids(d)[0], "live model must match what reopens").toEqual(ids(cold)[0]);
    expect(ids(cold)[0]).toContain("note-otherpane");
    expect(ids(cold)[0]).toContain("note-after");
    const bytes = [...files.files.values()].join("\n");
    for (const s of ["note-original", "note-incoming", "note-otherpane"]) expect(bytes).toContain(`"${s}"`);
    onlyLive(files);
  });

  it("(iv) sidecar deleted under an open pane: ink stays on screen and the next save restores it to the visible folder", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { files, d, clock } = await start(); const p = poll(d);
    await pollThroughBackoff(p);
    for (const [id] of both()) { files.files.delete(`handwriting/${id}.json`); files.mtimes.delete(`handwriting/${id}.json`); }
    for (const t of [1000, 6000, 12000]) { clock.now = t; await pollThroughBackoff(p); }
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    expect(p.notePaint()).toEqual(["note-original"]); expect(p.pane.painted).toEqual(["pdf-original"]);
    localEdit(d, "later");
    await d.ink.settle(); await d.store.flush();
    clock.now = 20000; await pollThroughBackoff(p);
    const cold = await reopen(d);
    expect(ids(cold)).toEqual([["note-original", "note-later"], ["pdf-original", "pdf-later"]]);
    expect(ids(d)).toEqual(ids(cold));
    onlyLive(files);
  });

  it.each(["damaged", "future"] as const)("(vi) %s incoming replacement is refused: old ink stays, a later save keeps the exact incoming bytes", async failure => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { files, d, clock } = await start(); const p = poll(d);
    await pollThroughBackoff(p);
    seed(files, "handwriting", "incoming");
    const bad = new Map<string, string>();
    for (const [id] of both()) {
      const path = `handwriting/${id}.json`, good = files.files.get(path)!;
      const bytes = failure === "damaged" ? good.slice(0, Math.floor(good.length / 2)) : JSON.stringify({ ...JSON.parse(good), schemaVersion: 999 });
      files.externalWrite(path, bytes); bad.set(id, bytes);
    }
    clock.now = 5000; await pollThroughBackoff(p);
    expect(ids(d)).toEqual([["note-original"], ["pdf-original"]]);
    expect(p.notePaint()).toEqual(["note-original"]); expect(p.pane.painted).toEqual(["pdf-original"]);
    localEdit(d, "later");
    await d.ink.settle(); await d.store.flush();
    clock.now = 10000; await pollThroughBackoff(p);
    const cold = await reopen(d);
    expect(ids(cold)).toEqual([["note-original", "note-later"], ["pdf-original", "pdf-later"]]);
    expect(ids(d)).toEqual(ids(cold));
    for (const [id] of both()) expect([...files.files.values()].includes(bad.get(id)!), `${id} incoming bytes kept exactly`).toBe(true);
    onlyLive(files);
  });
});
