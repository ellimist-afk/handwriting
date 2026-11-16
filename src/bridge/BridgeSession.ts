/**
 * What the plugin and the companion app are currently agreed on: which ink
 * surface the companion is drawing over, where it is, and which pen contacts
 * are the companion's to deliver.
 *
 * PLACING A STROKE. Points arrive in viewport pixels, and what is under a
 * given pixel changes with every scroll and zoom. So the mapping is taken at
 * `stroke-begin`, which the companion sends as the pen lands, and the stroke
 * is placed with that when it arrives whole at pen-up - not with the page as
 * it is by then.
 *
 * CLAIMS. The pen reaches the webview as well as the companion, so each
 * contact would be inked twice. The companion says `stroke-begin` the moment
 * the pen lands, long before the webview hears about the same contact; each
 * one is a claim, and a surface asks `takeContact()` before it keeps a
 * contact of its own. A contact with no claim is kept as it always was, so
 * a companion that is absent, paused or looking the other way costs no ink.
 *
 * Pure: surfaces, the socket and the clock are all handed in.
 */
import { sameGeometry, type BridgeGeometry, type BridgeIn, type BridgeOut, type BridgePen, type BridgePoint } from "./BridgeProtocol";

/** An ink surface the companion can draw over. The note surface and the pdf surface each provide one. */
export interface BridgeSurface {
	/** Where the surface is on screen, or null when none of it is. */
	geometry(): BridgeGeometry | null;
	/** The pen as it would draw now, or null when the tip is not the pen tool. */
	pen(): BridgePen | null;
	/** Whatever `land` will need to place a stroke drawn while the geometry is as it stands. */
	snapshot(): unknown;
	/** Commit a finished stroke. False when it could not be placed. */
	land(points: readonly BridgePoint[], snapshot: unknown): boolean;
}

/** A claim nobody took within this long of its stroke ending belongs to a contact the webview never saw. */
export const CLAIM_TTL_MS = 1500;

export class BridgeSession {
	private connected = false;
	private surface: BridgeSurface | null = null;
	private rev = 0;
	private sentGeometry: BridgeGeometry | null = null;
	private sentPen: BridgePen | null = null;
	private paused = false;
	private readonly begun = new Map<number, { surface: BridgeSurface; snapshot: unknown }>();
	private readonly claims: Array<{ id: number; endedAt: number | null }> = [];

	constructor(
		private readonly send: (message: BridgeOut) => boolean,
		private readonly now: () => number
	) {}

	/** The companion is there and has agreed a version. Everything it knew is gone: say it all again. */
	connectionOpened(): void {
		this.connected = true;
		this.forget();
		this.sync();
	}

	connectionClosed(): void {
		this.connected = false;
		this.forget();
	}

	/** Whether strokes can currently arrive from the companion. */
	get live(): boolean {
		return this.connected && this.surface !== null && this.sentGeometry !== null && !this.paused;
	}

	/** This surface is the one being written on now. */
	attach(surface: BridgeSurface): void {
		if (this.surface === surface) return;
		this.surface = surface;
		this.sync();
	}

	/** This surface is gone or no longer the one being written on. */
	detach(surface: BridgeSurface): void {
		if (this.surface !== surface) return;
		this.surface = null;
		this.sync();
	}

	get hasSurface(): boolean {
		return this.surface !== null;
	}

	/**
	 * Bring the companion up to date with the surface: its place, its pen, and
	 * whether the pen is the tool in hand. Cheap to call when nothing changed -
	 * it sends only what differs from what was last sent.
	 */
	sync(): void {
		if (!this.connected) return;
		const geometry = this.surface?.geometry() ?? null;
		if (!this.surface || !geometry) {
			if (this.sentGeometry) {
				this.send({ type: "close" });
				this.sentGeometry = null;
				this.sentPen = null;
				this.paused = false;
			}
			return;
		}
		if (!this.sentGeometry || !sameGeometry(this.sentGeometry, geometry)) {
			this.rev++;
			this.send({ type: "surface", rev: this.rev, ...geometry });
			this.sentGeometry = geometry;
		}
		const pen = this.surface.pen();
		if (!pen) {
			if (!this.paused) {
				this.send({ type: "pause", reason: "tool" });
				this.paused = true;
			}
			return;
		}
		if (!this.sentPen || this.sentPen.color !== pen.color || this.sentPen.width !== pen.width) {
			this.send({ type: "pen", ...pen });
			this.sentPen = pen;
		}
		if (this.paused) {
			this.send({ type: "resume" });
			this.paused = false;
		}
	}

	/**
	 * Is the pen contact a surface is looking at one the companion is
	 * delivering? True at most once per claim. Asked at pen-down, and again at
	 * pen-up by a surface that got no claim the first time: the companion's
	 * word normally arrives first, but nothing guarantees it.
	 */
	takeContact(): boolean {
		// A claim lasts as long as its stroke does, however long that is, and a
		// little past the end: the webview hears about a contact late.
		const now = this.now();
		for (let i = this.claims.length - 1; i >= 0; i--) {
			const ended = this.claims[i]!.endedAt;
			if (ended !== null && now - ended > CLAIM_TTL_MS) this.claims.splice(i, 1);
		}
		return this.claims.shift() !== undefined;
	}

	handle(message: BridgeIn): void {
		switch (message.type) {
			case "stroke-begin":
				this.claims.push({ id: message.id, endedAt: null });
				if (this.surface) this.begun.set(message.id, { surface: this.surface, snapshot: this.surface.snapshot() });
				return;
			case "stroke-cancel": {
				const at = this.claims.findIndex((c) => c.id === message.id);
				if (at >= 0) this.claims.splice(at, 1);
				this.begun.delete(message.id);
				return;
			}
			case "stroke": {
				const claim = this.claims.find((c) => c.id === message.id);
				if (claim) claim.endedAt = this.now();
				// A stroke whose beginning never arrived is placed with the page as it is now.
				const entry = this.begun.get(message.id) ?? (this.surface ? { surface: this.surface, snapshot: this.surface.snapshot() } : null);
				this.begun.delete(message.id);
				if (!entry) return;
				if (entry.surface.land(message.points, entry.snapshot)) this.send({ type: "landed", ids: [message.id] });
				return;
			}
			default:
				return;
		}
	}

	private forget(): void {
		this.rev = 0;
		this.sentGeometry = null;
		this.sentPen = null;
		this.paused = false;
		this.begun.clear();
		this.claims.length = 0;
	}
}
