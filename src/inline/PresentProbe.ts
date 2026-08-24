/**
 * Presentation probe: ground truth for the COMPOSITED frame.
 *
 * Everything so far instrumented Handwriting's side of the glass: input, mapping,
 * model, and canvas backing stores, all proven healthy while the dead zone
 * shows nothing. Three suspects survive: (a) an occluding element ABOVE the
 * ink canvases (elementFromPoint is blind to pointer-events:none overlays,
 * so this was never excluded), (b) the compositor dropping the canvas
 * layer's tiles, (c) the OS presenting a stale frame region below the
 * compositor. Two probes split them:
 *
 * REGION CENSUS: enumerate every element whose rect intersects the probe
 * box (the last commit's screen area), with the paint-relevant computed
 * style, in document order. An occluder above the Handwriting container is
 * visible here even when it is pointer-events:none. Also counts Handwriting
 * containers/canvases per editor; a leaked ghost overlay stack shows up as
 * counts > expected.
 *
 * PRESENTATION CAPTURE: Electron webContents.capturePage over the probe
 * box: the compositor's actual output. Compared against the committed
 * backing count for the same box:
 *   presented ≈ backing → the frame HAS the ink → glass loss is below the
 *     compositor (c), or an occluder repainted after capture (cross-check
 *     with the census).
 *   presented ≈ 0 with no occluder in the census → the compositor dropped
 *     the layer content (b).
 *   census shows an occluder above the container → (a), named directly.
 */

interface CensusRow {
	idx: number;
	desc: string;
	rect: string;
	z: string;
	position: string;
	opacity: string;
	background: string;
	pointerEvents: string;
	mixBlendMode: string;
	contain: string;
	isHandwriting: boolean;
	afterHandwriting: boolean;
}

function describe(el: Element): string {
	const cls =
		typeof el.className === "string" && el.className
			? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
			: "";
	const id = el.id ? `#${el.id}` : "";
	return `${el.tagName.toLowerCase()}${id}${cls}`;
}

export interface ProbeBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The slice of @electron/remote this probe touches. */
interface RemoteLike {
	getCurrentWebContents?: () => {
		capturePage?: (rect: { x: number; y: number; width: number; height: number }) => Promise<{
			getSize(): { width: number; height: number };
			getBitmap(): Uint8Array;
		}>;
	};
}

/** Every element intersecting the box, paint-relevant styles, doc order. */
export function regionCensus(
	box: ProbeBox,
	handwritingContainer: Element | null,
	liveContainers: Element[] = []
): string {
	const rows: CensusRow[] = [];
	const all = document.querySelectorAll("*");
	let handwritingSeen = false;
	let handwritingContainers = 0;
	let handwritingCanvases = 0;
	let ghostContainers = 0;
	let idx = 0;
	const liveSet = new Set(liveContainers);
	for (const el of Array.from(all)) {
		// Containers are identified two ways so the count cannot silently
		// read zero again: by class (restored from the lost build) OR by
		// membership in the live instance registry.
		const isContainer = el.classList?.contains("handwriting-ink-overlay") || liveSet.has(el);
		if (isContainer) {
			handwritingContainers++;
			if (!liveSet.has(el)) ghostContainers++;
			handwritingCanvases += el.querySelectorAll(":scope > canvas").length;
		}
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (r.right < box.x || r.left > box.x + box.w || r.bottom < box.y || r.top > box.y + box.h) {
			continue;
		}
		const isHandwriting = el === handwritingContainer || (handwritingContainer?.contains(el) ?? false);
		if (isHandwriting) handwritingSeen = true;
		const cs = getComputedStyle(el);
		if (cs.display === "none" || cs.visibility === "hidden") continue;
		rows.push({
			idx: idx++,
			desc: describe(el),
			rect: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`,
			z: cs.zIndex,
			position: cs.position,
			opacity: cs.opacity,
			background: cs.backgroundColor,
			pointerEvents: cs.pointerEvents,
			mixBlendMode: cs.mixBlendMode,
			contain: cs.contain,
			isHandwriting,
			afterHandwriting: handwritingSeen && !isHandwriting,
		});
	}
	const suspects = rows.filter(
		(r) =>
			r.afterHandwriting &&
			r.background !== "rgba(0, 0, 0, 0)" &&
			r.background !== "transparent" &&
			Number.parseFloat(r.opacity) > 0
	);
	const lines = [
		`Handwriting region census: box (${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.w.toFixed(0)}x${box.h.toFixed(0)}), ${rows.length} intersecting element(s)`,
		`handwriting containers in document: ${handwritingContainers} (${liveContainers.length} live, ${ghostContainers} unregistered)   handwriting canvases: ${handwritingCanvases}` +
			(ghostContainers > 0 || handwritingCanvases > 5 * Math.max(1, handwritingContainers)
				? "   *** GHOST OVERLAY SUSPECTED ***"
				: ""),
		suspects.length > 0
			? `*** ${suspects.length} element(s) AFTER the Handwriting container in paint order with a non-transparent background: occluder candidates ***`
			: "no non-transparent element paints after the Handwriting container in this box",
		"",
		"paint order (document order; later = on top within same stacking context):",
	];
	for (const r of rows) {
		lines.push(
			`  ${String(r.idx).padStart(3)} ${r.isHandwriting ? "[HANDWRITING] " : r.afterHandwriting ? "[AFTER] " : "        "}${r.desc}` +
				`  rect[${r.rect}] z=${r.z} pos=${r.position} op=${r.opacity} bg=${r.background} pe=${r.pointerEvents}` +
				(r.mixBlendMode !== "normal" ? ` blend=${r.mixBlendMode}` : "") +
				(r.contain !== "none" ? ` contain=${r.contain}` : "")
		);
	}
	return lines.join("\n");
}

/**
 * Composited-frame pixel count over the probe box, via Electron capturePage.
 * Counts pixels that differ from the box's own modal corner color (the
 * background) by more than a threshold, i.e. "something is drawn here".
 */
/** "#rgb" / "#rrggbb" → [r,g,b]; null when unparseable. */
export function parseHexColor(hex: string): [number, number, number] | null {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const s = m[1]!;
	if (s.length === 3) {
		return [
			parseInt(s[0]! + s[0]!, 16),
			parseInt(s[1]! + s[1]!, 16),
			parseInt(s[2]! + s[2]!, 16),
		];
	}
	return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export async function capturePresented(
	box: ProbeBox,
	inkRGB?: [number, number, number] | null
): Promise<{
	ok: boolean;
	detail: string;
	presentedPx: number;
	inkMatchedPx: number;
	sampledPx: number;
}> {
	try {
		// Obsidian ships @electron/remote wired through its preload. Resolved
		// dynamically so the module stays type-clean without node typings.
		const req = (window as { require?: (m: string) => unknown }).require;
		if (!req) {
			return { ok: false, detail: "require unavailable (not an Electron renderer)", presentedPx: 0, inkMatchedPx: 0, sampledPx: 0 };
		}
		const electron = req("electron") as { remote?: RemoteLike } | undefined;
		const remote =
			electron?.remote ??
			(() => {
				try {
					return req("@electron/remote") as RemoteLike;
				} catch {
					return null;
				}
			})();
		const wc = remote?.getCurrentWebContents?.();
		if (!wc?.capturePage) {
			return { ok: false, detail: "capturePage unavailable (no remote webContents)", presentedPx: 0, inkMatchedPx: 0, sampledPx: 0 };
		}
		const rect = {
			x: Math.max(0, Math.round(box.x)),
			y: Math.max(0, Math.round(box.y)),
			width: Math.max(1, Math.round(box.w)),
			height: Math.max(1, Math.round(box.h)),
		};
		const image = await wc.capturePage(rect);
		const size = image.getSize();
		const buf: Uint8Array = image.getBitmap(); // BGRA
		const w = size.width;
		const h = size.height;
		if (!buf || buf.length < w * h * 4) {
			return { ok: false, detail: `empty capture (${w}x${h})`, presentedPx: 0, inkMatchedPx: 0, sampledPx: 0 };
		}
		// Background estimate: modal color of the four corners.
		const corner = (x: number, y: number) => {
			const i = (y * w + x) * 4;
			return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
		};
		const corners = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)];
		const bg = corners[0]!;
		let presented = 0;
		let inkMatched = 0;
		const total = w * h;
		// getBitmap is BGRA: buf[o]=B, buf[o+2]=R.
		for (let i = 0; i < total; i++) {
			const o = i * 4;
			const b = buf[o]!;
			const g = buf[o + 1]!;
			const r = buf[o + 2]!;
			if (Math.abs(b - bg[0]) > 40 || Math.abs(g - bg[1]) > 40 || Math.abs(r - bg[2]) > 40) {
				presented++;
			}
			if (
				inkRGB &&
				Math.abs(r - inkRGB[0]) < 60 &&
				Math.abs(g - inkRGB[1]) < 60 &&
				Math.abs(b - inkRGB[2]) < 60
			) {
				inkMatched++;
			}
		}
		return {
			ok: true,
			detail: `capture ${w}x${h} device px, bg(BGR)=(${bg[0]},${bg[1]},${bg[2]}), corners=${corners
				.map((c) => `(${c[0]},${c[1]},${c[2]})`)
				.join(" ")}` + (inkRGB ? `, ink RGB target (${inkRGB[0]},${inkRGB[1]},${inkRGB[2]})` : ""),
			presentedPx: presented,
			inkMatchedPx: inkMatched,
			sampledPx: total,
		};
	} catch (err) {
		return { ok: false, detail: `capture failed: ${String(err)}`, presentedPx: 0, inkMatchedPx: 0, sampledPx: 0 };
	}
}
