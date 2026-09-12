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
async function device(adapter = new SyncAdapter(), raw: unknown = {}) {
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
function poll(d: Device) {
  let callback!: () => void, pending = Promise.resolve();
  const errors: unknown[] = [];
  let notePaint = d.ink.strokes(notePath).map(s => s.id);
  const pane = { idle: true, painted: d.pdf.strokes(pdfId).map(s => s.id), refresh() { this.painted = d.pdf.strokes(pdfId).map(s => s.id); } };
  const root = { isConnected: true };
  const state = { store: d.store, pdfStore: d.pdf, pdfInk: new Map([[root, pane]]), pdfIds: new Map([[root, pdfId]]),
    pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 }, registerInterval() {} };
  installLiveReloadPoll.call(state, { setInterval(fn: () => void) { callback = fn; return 1; } }, { hidden: false },
    (p: Promise<void>) => { pending = p; }, () => [notePath], d.ink,
    () => {}, () => { notePaint = d.ink.strokes(notePath).map(s => s.id); },
    () => null, async () => false, { error: (...args: unknown[]) => errors.push(args) });
  return { pane, errors, notePaint: () => notePaint, async tick() { callback(); await pending; } };
}
function transfer(from: SyncAdapter, to: SyncAdapter) {
  // A synthetic transport carries visible paths, not .handwriting or settings.
  for (const [path, bytes] of from.files) if (path.startsWith("handwriting/")) {
    to.dirs.add("handwriting"); to.externalWrite(path, bytes);
  }
}
function ids(d: Device) { return [d.ink.strokes(notePath).map(s => s.id), d.pdf.strokes(pdfId).map(s => s.id)]; }
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
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { body: { classList: { add() {}, toggle() {}, contains: () => false } } });
  pdfId = await pdfInkId(new TextEncoder().encode("%PDF-1.4 synthetic identity fixture"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("compatibility across two synthetic devices", () => {
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
});
