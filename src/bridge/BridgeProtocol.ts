/**
 * The wire format between the plugin and the e-ink companion app.
 *
 * On an e-ink tablet the fast pen path is a native one the webview cannot
 * reach. A companion app can: it draws the line in firmware as the pen moves
 * and hands the finished stroke over a loopback WebSocket. This file is the
 * whole of what the two ends agree on - one JSON object per frame, a `type`
 * on each - and nothing else in the plugin spells a message by hand.
 *
 * Every position is in CSS pixels of the webview's viewport, the space
 * `clientX` and `getBoundingClientRect()` already report, so no surface ever
 * converts to or from screen pixels.
 *
 * Pure: no `obsidian` import, no DOM, no socket.
 */

export const BRIDGE_PROTOCOL = 1;

/** Loopback ports the companion listens on, in the order they are tried. */
export const BRIDGE_PORTS: readonly number[] = [47810, 47811];

export function bridgeUrl(port: number): string {
	return `ws://127.0.0.1:${port}/`;
}

export interface BridgeRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type BridgeSurfaceKind = "note" | "pdf";

/** Where ink may be drawn, as the companion is told it. */
export interface BridgeGeometry {
	kind: BridgeSurfaceKind;
	/** The part of the surface that is on screen. */
	rect: BridgeRect;
	/** Rectangles inside `rect` the pen must not draw on: the toolbar. */
	exclude: BridgeRect[];
	viewport: { w: number; h: number };
	dpr: number;
}

export interface BridgePen {
	/** `#rrggbb`. */
	color: string;
	/** Nib width in CSS px, as it shows on screen. */
	width: number;
}

export type BridgeOut =
	| { type: "hello"; protocol: number; client: string; version: string; token: string }
	| ({ type: "surface"; rev: number } & BridgeGeometry)
	| ({ type: "pen" } & BridgePen)
	| { type: "pause"; reason: string }
	| { type: "resume" }
	| { type: "close" }
	| { type: "landed"; ids: number[] };

/** One point of a stroke: viewport CSS px, pressure 0..1, ms since the stroke began. */
export interface BridgePoint {
	x: number;
	y: number;
	pressure: number;
	t: number;
}

export type BridgeIn =
	| { type: "welcome"; protocol: number; app: string; version: string }
	| { type: "stroke-begin"; id: number; rev: number }
	| { type: "stroke"; id: number; rev: number; points: BridgePoint[] }
	| { type: "stroke-cancel"; id: number }
	| { type: "denied"; reason: string };

/**
 * A pairing secret: 32 characters the companion will accept, from `random`,
 * which fills a byte array (`crypto.getRandomValues`). Made once per device.
 * The companion asks the person holding the tablet to approve it the first
 * time it is presented, and after that it is what tells this plugin apart
 * from any other app on the tablet that can reach the same loopback port.
 */
export function newBridgeToken(random: (bytes: Uint8Array<ArrayBuffer>) => void): string {
	const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const bytes = new Uint8Array(32);
	random(bytes);
	let out = "";
	for (const b of bytes) out += ALPHABET[b & 63];
	return out;
}

/** Whether a stored value is a secret this build would have made. Anything else is replaced. */
export function isBridgeToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function encodeBridge(message: BridgeOut): string {
	return JSON.stringify(message);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A frame from the companion, or null when it is not one this build
 * understands. Null is not an error: a newer companion may say things an
 * older plugin has no use for, and the socket stays open either way. A
 * `stroke` with one bad point is refused whole - half a stroke is worse than
 * a missing one, because nothing downstream could tell it had been cut.
 */
export function decodeBridge(text: string): BridgeIn | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const m = raw as Record<string, unknown>;
	switch (m.type) {
		case "welcome":
			if (!finite(m.protocol)) return null;
			return {
				type: "welcome",
				protocol: m.protocol,
				app: typeof m.app === "string" ? m.app : "",
				version: typeof m.version === "string" ? m.version : "",
			};
		case "stroke-begin":
			if (!finite(m.id) || !finite(m.rev)) return null;
			return { type: "stroke-begin", id: m.id, rev: m.rev };
		case "denied":
			return { type: "denied", reason: typeof m.reason === "string" ? m.reason : "" };
		case "stroke-cancel":
			if (!finite(m.id)) return null;
			return { type: "stroke-cancel", id: m.id };
		case "stroke": {
			if (!finite(m.id) || !finite(m.rev) || !Array.isArray(m.points)) return null;
			const points: BridgePoint[] = [];
			for (const p of m.points as unknown[]) {
				if (!Array.isArray(p)) return null;
				const [x, y, pressure, t] = p as unknown[];
				if (!finite(x) || !finite(y) || !finite(pressure) || !finite(t)) return null;
				points.push({ x, y, pressure: Math.min(1, Math.max(0, pressure)), t });
			}
			if (points.length === 0) return null;
			return { type: "stroke", id: m.id, rev: m.rev, points };
		}
		default:
			return null;
	}
}

const sameRect = (a: BridgeRect, b: BridgeRect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** Whether two geometries would put the companion's overlay in the same place. */
export function sameGeometry(a: BridgeGeometry, b: BridgeGeometry): boolean {
	return (
		a.kind === b.kind &&
		a.dpr === b.dpr &&
		a.viewport.w === b.viewport.w &&
		a.viewport.h === b.viewport.h &&
		sameRect(a.rect, b.rect) &&
		a.exclude.length === b.exclude.length &&
		a.exclude.every((r, i) => sameRect(r, b.exclude[i]!))
	);
}
