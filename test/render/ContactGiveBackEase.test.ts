/**
 * A contact that owns nothing gives back the ease it cancelled, as an ease, with no jump.
 *
 * Off-centre pinch-out 100% -> 10%, canvas on, the same glide TapDuringGlide drives. 100ms into the post-lift glide one
 * contact lands on the pane, is held for three frames and lifts: a mouse click (mouse ink off), a pen tap with pen input
 * off on a device that has seen a pen, a palm the pen gate swallows (pen hovering beside it), and a finger tap as the
 * control. InlinePenRouter.pointerDown calls onViewportInput for every one of them, which cancels the playing ease and
 * folds what it still owed into the pan; the lift has to give that back through onAllContactsLifted
 * (InkOverlay.resumeStrandedPan). The finger tap always did; the other three ended elsewhere and left the page frozen
 * mid-glide.
 *
 * Every arm, read off painted positions (the content's rect against the pane's, both axes):
 *   - the first frame after the down sits within 1 px of the last frame before it (the cancel moves nothing);
 *   - read right after the lift, before any frame, the page sits within 1 px of the last held frame (the give-back
 *     starts where the page stands; an instant close to the bound fails here);
 *   - the first painted frame after the lift moves the page no faster, in px per ms of its own frame interval, than
 *     the glide's last frame before the contact did: the ease's own first step is not a jump, and the contact never
 *     speeds the page up. A rate, not a distance, so a long frame on either side does not decide it: the eased
 *     remainder R starts at 3R/500 px/ms, which is the glide's own rate at the contact times the share of its 500 ms
 *     still to run, so always less;
 *   - an ease is playing on that frame;
 *   - the page comes to rest at its bound, and nothing is left playing.
 *
 * Logs the cancelOverscrollBounce entry (build-time patch on its own guard line, source on disk untouched) so the
 * premise - the contact genuinely cancelled a playing ease - is checked, not assumed.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { markPenHardwareSeen, deviceHasNeverSeenAPen } from "../../src/inline/PenToolsMode";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
// Resolves with the frame's own timestamp: the ease reads its clock off it, so the per-frame rates below do too.
const rendered = () => new Promise(r => requestAnimationFrame(ts => setTimeout(() => r(ts), 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const r2 = v => Math.round(v * 100) / 100;

function sample(phase, ft = null) {
	const { view, overlay, pane } = rig;
	const pr = pane.getBoundingClientRect(), cr = view.contentDOM.getBoundingClientRect();
	const b = overlay.overscrollBounceReadout();
	return { phase, t: r2(performance.now()), ft: ft === null ? null : r2(ft), k: overlay.pinchScaleNow,
		panX: r2(overlay.viewportPan.x), panY: r2(overlay.viewportPan.y),
		leftEdgePx: r2(cr.left - pr.left), topEdgePx: r2(cr.top - pr.top),
		bounce: { active: b.active, x: r2(b.x), y: r2(b.y), fromX: r2(b.fromX), fromY: r2(b.fromY), startedAt: b.startedAt } };
}

window.giveBackProbe = {
	async mount(tag) {
		setScrollExpansionEnabled(true);
		const path = "give-back-" + (tag || "x") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		return sample("natural");
	},
	/** kind: "mouse" | "pen" | "palm" | "finger". */
	async contactDuringGlide(kind) {
		const { overlay, pane, view } = rig, router = overlay.router;
		if (kind === "pen") { markPenHardwareSeen(); setPenInk(false); }
		const premise = { kind, penNeverSeen: deviceHasNeverSeenAPen(), penOff: overlay.router.cb.penOff?.() ?? null };
		const r = pane.getBoundingClientRect(), cx = r.left + r.width * 0.6, cy = r.top + r.height / 2;
		const spread0 = 300, spread1 = 300 * 0.10 / overlay.pinchScaleNow, steps = 30;
		const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		const rows = [sample("before")];
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); }
		router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
		for (let j = 1; j <= 6; j++) { const ft = await rendered(); rows.push(sample("glide-" + j, ft)); }
		// The contact, well away from the pinch centre.
		const tx = r.left + 20, ty = r.top + 20;
		const pointerType = kind === "mouse" ? "mouse" : kind === "pen" ? "pen" : "touch";
		const id = kind === "mouse" ? 1 : kind === "pen" ? 970 : 950;
		const init = (buttons) => ({ bubbles: true, cancelable: true, pointerId: id, pointerType, clientX: tx, clientY: ty, isPrimary: true,
			button: 0, buttons, pressure: buttons ? 0.5 : 0, width: kind === "palm" ? 40 : 1, height: kind === "palm" ? 40 : 1 });
		if (kind === "palm") {
			// The pen hovers beside the hand: the gate blocks a touch that lands now.
			view.scrollDOM.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 960, pointerType: "pen",
				clientX: tx + 200, clientY: ty + 200, isPrimary: true, buttons: 0, pressure: 0 }));
		}
		const palmsBefore = router.palmsBlocked ?? 0;
		view.scrollDOM.dispatchEvent(new PointerEvent("pointerdown", init(1)));
		premise.claimed = router.activePenId !== null;
		premise.swallowed = (router.palmsBlocked ?? 0) - palmsBefore;
		rows.push(sample("down-sync"));
		for (let h = 1; h <= 3; h++) { const ft = await rendered(); rows.push(sample("held-" + h, ft)); }
		view.scrollDOM.dispatchEvent(new PointerEvent("pointerup", init(0)));
		rows.push(sample("up-sync"));
		for (let j = 1; j <= 60; j++) { const ft = await rendered(); rows.push(sample("after-" + j, ft)); }
		return { premise, rows };
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];

beforeAll(async () => {
	const from = "if (!offset || (!state && offset.x === 0 && offset.y === 0)) return;";
	const to = 'if (offset && state) console.log("CANCEL-BOUNCE-ACTIVE", JSON.stringify({x:offset.x,y:offset.y}));\n\t\tif (!offset || (!state && offset.x === 0 && offset.y === 0)) return;';
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "giveBackPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: [{ name: "cancel-log", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				const text = readFileSync(args.path, "utf8");
				if (text.split(from).length !== 2) throw new Error("give-back probe: cancelOverscrollBounce anchor not found once");
				planted++;
				return { loader: "ts", contents: text.replace(from, to) };
			});
		} }] });
	if (planted !== 1) throw new Error("give-back probe: patch applied " + planted + " times, not once");
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_GIVEBACK_OUT) writeFileSync(process.env.HW_GIVEBACK_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).giveBackProbe[m](...a), [method, args] as const);

type Row = { phase: string; ft: number | null; panX: number; panY: number; leftEdgePx: number; topEdgePx: number; bounce: { active: boolean } };

async function runArm(kind: string): Promise<{ premise: any; rows: Row[]; cancels: number; pageErrors: string[] }> {
	const p = await browser.newPage({ viewport: { width: 1800, height: 900 }, hasTouch: true });
	let cancels = 0;
	p.on("console", m => { if (m.text().startsWith("CANCEL-BOUNCE-ACTIVE")) cancels++; });
	const pageErrors: string[] = [];
	p.on("pageerror", e => pageErrors.push(String(e.message).slice(0, 200)));
	await p.setContent('<!doctype html><body style="margin:0"></body>');
	await p.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await p.addScriptTag({ content: script });
	await call(p, "mount", kind);
	const { premise, rows } = await call(p, "contactDuringGlide", kind) as { premise: any; rows: Row[] };
	await p.close();
	record.push({ kind, premise, cancels, pageErrors, rows });
	return { premise, rows, cancels, pageErrors };
}

const at = (rows: Row[], phase: string): Row => {
	const row = rows.find(r => r.phase === phase);
	if (!row) throw new Error("no row " + phase);
	return row;
};
const moved = (a: Row, b: Row) => Math.max(Math.abs(b.leftEdgePx - a.leftEdgePx), Math.abs(b.topEdgePx - a.topEdgePx));

function checkArm(kind: string, run: Awaited<ReturnType<typeof runArm>>): void {
	const { rows, cancels, pageErrors, premise } = run;
	const beforeLast = at(rows, "glide-5"), last = at(rows, "glide-6"), firstAfterCancel = at(rows, "held-1"), held = at(rows, "held-3");
	const atLift = at(rows, "up-sync"), firstAfterLift = at(rows, "after-1"), rest = rows.at(-1)!;
	expect(pageErrors, `${kind}: no page errors`).toEqual([]);
	expect(cancels, `${kind} premise: the contact really did cancel a playing ease`).toBeGreaterThan(0);
	expect(premise.claimed, `${kind} premise: the contact owned nothing`).toBe(false);
	if (kind === "palm") expect(premise.swallowed, "palm premise: the pen gate swallowed the touch").toBe(1);
	if (kind === "pen") expect(premise.penOff, "pen premise: pen input is off on a device that has seen a pen").toBe(true);
	expect.soft(moved(last, firstAfterCancel), `${kind}: first frame after the down within 1 px of the last frame before it`).toBeLessThanOrEqual(1);
	expect.soft(moved(held, atLift), `${kind}: read right after the lift, before any frame, within 1 px of the last held frame (${JSON.stringify({ held, atLift })})`).toBeLessThanOrEqual(1);
	const glideMs = last.ft! - beforeLast.ft!, liftMs = firstAfterLift.ft! - held.ft!;
	expect.soft(glideMs > 0 && liftMs > 0, `${kind} premise: both frame intervals read (${glideMs} ms, ${liftMs} ms)`).toBe(true);
	const glideRate = moved(beforeLast, last) / glideMs, liftRate = moved(held, firstAfterLift) / liftMs;
	expect.soft(glideRate, `${kind} premise: the glide was moving before the contact`).toBeGreaterThan(0.05);
	expect.soft(liftRate, `${kind}: first painted frame after the lift moves no faster than the glide's last frame before the contact (${liftRate.toFixed(3)} against ${glideRate.toFixed(3)} px/ms)`).toBeLessThanOrEqual(glideRate);
	expect.soft(firstAfterLift.bounce.active, `${kind}: an ease is playing on the first frame after the lift`).toBe(true);
	expect.soft(Math.max(Math.abs(rest.panX), Math.abs(rest.leftEdgePx)), `${kind}: rest at the bound, not frozen mid-glide (rest ${JSON.stringify(rest)})`).toBeLessThanOrEqual(0.5);
	expect.soft(rest.bounce.active, `${kind}: nothing left playing at rest`).toBe(false);
}

it("control: a finger tap during the glide gives the ease back with no jump", async () => {
	checkArm("finger", await runArm("finger"));
}, 60_000);

it("a mouse click during the glide gives the ease back with no jump", async () => {
	checkArm("mouse", await runArm("mouse"));
}, 60_000);

it("a pen tap with pen input off during the glide gives the ease back with no jump", async () => {
	checkArm("pen", await runArm("pen"));
}, 60_000);

it("a palm the pen gate swallowed during the glide gives the ease back with no jump", async () => {
	checkArm("palm", await runArm("palm"));
}, 60_000);
