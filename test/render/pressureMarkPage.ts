import { drawStroke } from "../../src/ink/StrokeRenderer";
import { setPressureSensitivity } from "../../src/ink/PenStyle";
import { parsePage } from "../../src/model/PageData";

type Call = [string, ...unknown[]];

function canvas(w: number, h: number): CanvasRenderingContext2D {
	const c = document.body.appendChild(document.createElement("canvas"));
	c.width = w;
	c.height = h;
	return c.getContext("2d")!;
}

/** Play a recorded draw back onto a real context: calls are called, `=prop` entries are assigned. */
function replay(ctx: CanvasRenderingContext2D, log: Call[]): void {
	const target = ctx as unknown as Record<string, unknown>;
	for (const [name, ...args] of log) {
		if (name.startsWith("=")) target[name.slice(1)] = args[0];
		else (target[name] as (...a: unknown[]) => void).apply(ctx, args);
	}
}

/**
 * The 1.4.22 fixture painted twice per setting: once by today's drawStroke,
 * once by replaying the draw 1.4.22 recorded. Returns the pixel difference.
 */
function compare(stored: unknown[], cases: Array<{ id: string; pressureOn: boolean; drawLog: Call[] }>, pressureOn: boolean) {
	document.body.replaceChildren();
	const parsed = parsePage(JSON.stringify({ schemaVersion: 1, pageId: "pressure-mark-1422", strokes: stored }), "pressure-mark-1422");
	const W = 640, H = 400;
	const now = canvas(W, H), then = canvas(W, H);
	setPressureSensitivity(pressureOn);
	for (const s of parsed.data.strokes) drawStroke(now, { x: 0, y: 0, zoom: 1 }, s, undefined, true, false);
	for (const c of cases) if (c.pressureOn === pressureOn) replay(then, c.drawLog);
	setPressureSensitivity(true);
	const a = now.getImageData(0, 0, W, H).data, b = then.getImageData(0, 0, W, H).data;
	let over = 0, ink = 0, maxDiff = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i]! - b[i]!);
		if (d > maxDiff) maxDiff = d;
		if (d > 0) over++;
		if (i % 4 === 3 && b[i]! > 0) ink++;
	}
	return { over, ink, maxDiff };
}

(window as unknown as { pressureMarkPage: unknown }).pressureMarkPage = { compare };
