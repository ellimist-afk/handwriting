/**
 * The writable surface on the project site (docs/index.html).
 *
 * It runs the plugin's own ink path rather than a lookalike: StrokeBuilder
 * does the sampling and the release-travel rejection, drawStroke lays the
 * shaped ribbon down, and the width law is the one a note uses. Somebody
 * trying this on a Surface or a Boox is feeling the real thing before they
 * install anything.
 *
 * Nothing in this file or below it imports Obsidian. scripts/build-site.mjs
 * bundles it to docs/demo.js, which is the only place it runs.
 */
import { CameraState } from "../camera/coordinates";
import { drawStroke } from "../ink/StrokeRenderer";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { InkPoint, InkStroke, InkTool, computeBBox } from "../ink/Stroke";
import { inkToSvg } from "../ink/SvgExport";

/** The page never pans or zooms, so world space and CSS pixels are the same. */
const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

interface Tool {
	tool: InkTool;
	color: string;
	width: number;
}

const TOOLS = {
	violet: { tool: "pen", color: "#6d3fc4", width: 2.6 },
	ink: { tool: "pen", color: "#1b1a23", width: 2.6 },
	red: { tool: "pen", color: "#c0392f", width: 2.6 },
	highlighter: { tool: "highlighter", color: "#f2c14b", width: 16 },
} satisfies Record<string, Tool>;

type ToolName = keyof typeof TOOLS;

function toolByName(name: string): Tool {
	return name in TOOLS ? TOOLS[name as ToolName] : TOOLS.violet;
}

class InkDemo {
	private ctx: CanvasRenderingContext2D;
	private strokes: InkStroke[] = [];
	private builder: StrokeBuilder | null = null;
	/**
	 * The builder keeps its samples private and only hands back the ones it
	 * accepted, so the live stroke is assembled from those return values. The
	 * dedupe and the release-travel gate still belong to the builder.
	 */
	private live: InkPoint[] = [];
	private liveDevice: "mouse" | undefined;
	private activeId: number | null = null;
	private tool: Tool = TOOLS.violet;
	private frame = 0;

	constructor(
		private canvas: HTMLCanvasElement,
		private onFirstStroke: () => void
	) {
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		this.ctx = ctx;
		this.resize();
		new ResizeObserver(() => this.resize()).observe(canvas);
		canvas.addEventListener("pointerdown", (e) => this.down(e));
		canvas.addEventListener("pointermove", (e) => this.move(e));
		canvas.addEventListener("pointerup", (e) => this.up(e));
		canvas.addEventListener("pointercancel", (e) => this.up(e));
		// A pen or finger on the surface must not scroll the page under it.
		canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
	}

	setTool(name: string): void {
		this.tool = toolByName(name);
	}

	undo(): void {
		this.strokes.pop();
		this.paint();
	}

	clear(): void {
		this.strokes = [];
		this.paint();
	}

	get isEmpty(): boolean {
		return this.strokes.length === 0 && this.live.length === 0;
	}

	/** The same call the plugin's "Export ink as SVG" command makes. */
	exportSvg(): string {
		return inkToSvg(this.strokes);
	}

	private resize(): void {
		const dpr = window.devicePixelRatio || 1;
		const rect = this.canvas.getBoundingClientRect();
		this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
		this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
		this.paint();
	}

	private point(e: PointerEvent): { x: number; y: number; p: number } {
		const rect = this.canvas.getBoundingClientRect();
		// A mouse reports 0.5 while a button is down and 0 otherwise; a pen
		// that reports nothing gets the same mid value rather than a hairline.
		const raw = e.pressure > 0 ? e.pressure : 0.5;
		return { x: e.clientX - rect.left, y: e.clientY - rect.top, p: raw };
	}

	private down(e: PointerEvent): void {
		if (this.activeId !== null) return;
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		this.canvas.setPointerCapture(e.pointerId);
		this.activeId = e.pointerId;
		// A mouse has no pressure and its speed says nothing about intent, so
		// the stroke is marked and the shaped width law stands down for it.
		this.liveDevice = e.pointerType === "mouse" ? "mouse" : undefined;
		this.builder = new StrokeBuilder(
			this.tool.tool,
			this.tool.color,
			this.tool.width,
			0.15,
			this.liveDevice
		);
		this.builder.start(e.timeStamp);
		this.live = [];
		this.add(e);
		this.onFirstStroke();
	}

	private move(e: PointerEvent): void {
		if (this.activeId !== e.pointerId || !this.builder) return;
		e.preventDefault();
		// Coalesced samples are where the pen's real resolution lives; one
		// pointermove can carry a dozen of them on a fast stroke.
		const batch = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		if (batch.length > 0) {
			for (const c of batch) this.add(c);
		} else {
			this.add(e);
		}
		this.schedule();
	}

	private up(e: PointerEvent): void {
		if (this.activeId !== e.pointerId || !this.builder) return;
		const done = this.builder.finish();
		if (done) this.strokes.push(done);
		this.builder = null;
		this.live = [];
		this.activeId = null;
		this.paint();
	}

	private add(e: PointerEvent): void {
		if (!this.builder) return;
		const { x, y, p } = this.point(e);
		const accepted = this.builder.add(x, y, p, e.timeStamp);
		if (accepted) this.live.push(accepted);
	}

	private schedule(): void {
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			this.paint();
		});
	}

	private paint(): void {
		const dpr = window.devicePixelRatio || 1;
		const { ctx } = this;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.scale(dpr, dpr);
		for (const s of this.strokes) drawStroke(ctx, CAM, s, undefined, true);
		if (this.live.length > 1) {
			const wet: InkStroke = {
				id: "live",
				tool: this.tool.tool,
				color: this.tool.color,
				width: this.tool.width,
				points: this.live,
				bbox: computeBBox(this.live, this.tool.width),
				createdAt: 0,
			};
			if (this.liveDevice) wet.device = this.liveDevice;
			drawStroke(ctx, CAM, wet, undefined, true);
		}
	}
}

function boot(): void {
	const canvas = document.querySelector<HTMLCanvasElement>("#ink-demo");
	const hint = document.querySelector<HTMLElement>("#ink-hint");
	if (!canvas) return;
	const demo = new InkDemo(canvas, () => hint?.setAttribute("data-written", "yes"));

	for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"))) {
		btn.addEventListener("click", () => {
			for (const other of Array.from(document.querySelectorAll("[data-tool]"))) {
				other.setAttribute("aria-pressed", other === btn ? "true" : "false");
			}
			demo.setTool(btn.dataset.tool ?? "violet");
		});
	}
	document.querySelector("#ink-export")?.addEventListener("click", () => {
		const svg = demo.exportSvg();
		if (!svg) return;
		// Cropped to the drawing, on no background, exactly as the note's own
		// export writes it beside the .md.
		const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = "handwriting.svg";
		a.click();
		URL.revokeObjectURL(url);
	});
	document.querySelector("#ink-undo")?.addEventListener("click", () => demo.undo());
	document.querySelector("#ink-clear")?.addEventListener("click", () => {
		demo.clear();
		hint?.removeAttribute("data-written");
	});
	// A pen that never arrives is worth saying out loud: the mouse path is a
	// real setting in the plugin, and it is what most desktop visitors have.
	const note = document.querySelector<HTMLElement>("#ink-pointer-note");
	if (note && !window.matchMedia("(pointer: fine)").matches) {
		note.textContent = "No pen? Drag with a finger. There will be no pressure.";
	}
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot);
} else {
	boot();
}
