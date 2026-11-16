/**
 * The socket to the companion app: find it, shake hands, keep trying quietly.
 *
 * The companion is optional and usually absent - the setting can be on with
 * nothing installed, or the app can be started an hour after Obsidian. So a
 * failed connection is the ordinary case, not an error: nothing is thrown,
 * nothing is shown, and the next attempt waits longer than the last up to a
 * ceiling. `nudge()` skips the wait when something suggests the answer may
 * have changed.
 *
 * The socket constructor and the clock are handed in. That is what lets the
 * whole lifecycle run under vitest with no network and no real timer, and it
 * keeps this file free of `window`.
 */
import { BRIDGE_PORTS, BRIDGE_PROTOCOL, bridgeUrl, decodeBridge, encodeBridge, type BridgeIn, type BridgeOut } from "./BridgeProtocol";

/** The part of a WebSocket this file uses. */
export interface BridgeSocket {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
}

export interface BridgeTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/**
 * "pairing" is searching with a reason known: the companion is there and has
 * asked the person holding the tablet whether this plugin may connect.
 */
export type BridgeState = "off" | "searching" | "pairing" | "ready";

export interface BridgeClientOptions {
	open(url: string): BridgeSocket;
	timers: BridgeTimers;
	/** The plugin's version, for the companion's log. */
	version: string;
	/** This device's pairing secret (`newBridgeToken`). */
	token: string;
	onMessage(message: BridgeIn): void;
	onState(state: BridgeState): void;
}

/** How long the companion has to answer `hello` before it counts as absent. */
export const WELCOME_TIMEOUT_MS = 2000;

/** Waits between rounds of attempts. The last one repeats. */
export const RETRY_MS: readonly number[] = [2000, 5000, 15000, 30000];

export class BridgeClient {
	private socket: BridgeSocket | null = null;
	private ready = false;
	private started = false;
	private pairing = false;
	private portIndex = 0;
	private round = 0;
	private welcomeTimer: unknown = null;
	private retryTimer: unknown = null;

	constructor(private readonly opts: BridgeClientOptions) {}

	get state(): BridgeState {
		if (!this.started) return "off";
		return this.ready ? "ready" : this.pairing ? "pairing" : "searching";
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.round = 0;
		this.opts.onState(this.state);
		this.attempt(0);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.pairing = false;
		this.clearTimers();
		this.drop();
		this.opts.onState(this.state);
	}

	/** Try again now rather than at the end of the current wait. No-op unless waiting. */
	nudge(): void {
		if (!this.started || this.socket !== null || this.retryTimer === null) return;
		this.opts.timers.clear(this.retryTimer);
		this.retryTimer = null;
		this.round = 0;
		this.attempt(0);
	}

	/** False when there is nobody to hear it. Never throws. */
	send(message: BridgeOut): boolean {
		if (!this.ready || !this.socket) return false;
		try {
			this.socket.send(encodeBridge(message));
			return true;
		} catch {
			return false;
		}
	}

	private attempt(portIndex: number): void {
		this.portIndex = portIndex;
		let socket: BridgeSocket;
		try {
			socket = this.opts.open(bridgeUrl(BRIDGE_PORTS[portIndex]!));
		} catch {
			this.failed();
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket !== socket) return;
			try {
				socket.send(encodeBridge({ type: "hello", protocol: BRIDGE_PROTOCOL, client: "handwriting", version: this.opts.version, token: this.opts.token }));
			} catch {
				this.lost(socket);
				return;
			}
			this.welcomeTimer = this.opts.timers.set(() => {
				this.welcomeTimer = null;
				this.lost(socket);
			}, WELCOME_TIMEOUT_MS);
		};
		socket.onmessage = (ev) => {
			if (this.socket !== socket || typeof ev.data !== "string") return;
			const message = decodeBridge(ev.data);
			if (!message) return;
			if (!this.ready) {
				// Anything before the welcome is not from a companion that
				// has agreed to a version, so it is not acted on.
				if (message.type === "denied") {
					// The companion is there and will not talk yet. It closes the
					// socket itself; the wait that follows is the ordinary one, and
					// coming back to Obsidian after answering the companion's
					// question nudges it.
					if (!this.pairing) {
						this.pairing = true;
						this.opts.onState(this.state);
					}
					return;
				}
				if (message.type !== "welcome" || message.protocol !== BRIDGE_PROTOCOL) return;
				this.clearWelcome();
				this.pairing = false;
				this.ready = true;
				this.round = 0;
				this.opts.onState(this.state);
				return;
			}
			if (message.type !== "welcome" && message.type !== "denied") this.opts.onMessage(message);
		};
		socket.onclose = () => this.lost(socket);
		socket.onerror = () => this.lost(socket);
	}

	/** This socket is finished, however it ended. Idempotent per socket. */
	private lost(socket: BridgeSocket): void {
		if (this.socket !== socket) return;
		const wasReady = this.ready;
		this.clearWelcome();
		this.drop();
		if (!this.started) return;
		if (wasReady) {
			// It was there a moment ago: look again from the top, soon.
			this.opts.onState(this.state);
			this.round = 0;
			this.wait();
			return;
		}
		this.failed();
	}

	/** One port did not answer: the next port, or the wait before another round. */
	private failed(): void {
		if (!this.started) return;
		const next = this.portIndex + 1;
		if (next < BRIDGE_PORTS.length) this.attempt(next);
		else this.wait();
	}

	private wait(): void {
		const ms = RETRY_MS[Math.min(this.round, RETRY_MS.length - 1)]!;
		this.round++;
		this.retryTimer = this.opts.timers.set(() => {
			this.retryTimer = null;
			this.attempt(0);
		}, ms);
	}

	private drop(): void {
		const socket = this.socket;
		this.socket = null;
		this.ready = false;
		if (!socket) return;
		socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
		try {
			socket.close();
		} catch {
			// Already gone.
		}
	}

	private clearWelcome(): void {
		if (this.welcomeTimer === null) return;
		this.opts.timers.clear(this.welcomeTimer);
		this.welcomeTimer = null;
	}

	private clearTimers(): void {
		this.clearWelcome();
		if (this.retryTimer !== null) {
			this.opts.timers.clear(this.retryTimer);
			this.retryTimer = null;
		}
	}
}
