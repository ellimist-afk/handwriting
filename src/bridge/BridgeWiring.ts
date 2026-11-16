/**
 * Turning the companion link on and off: the one place that touches the real
 * WebSocket, the real timers and the platform check.
 *
 * Android only. The companion is an Android app and the socket is loopback,
 * so on every other platform the setting can be on - it syncs with the vault
 * - and nothing is opened, scheduled or listened for.
 */
import { type App, Platform } from "obsidian";
import { BridgeClient, type BridgeSocket, type BridgeState } from "./BridgeClient";
import { bridgeChanged, setBridgeSession } from "./BridgeHub";
import { isBridgeToken, newBridgeToken } from "./BridgeProtocol";
import { BridgeSession } from "./BridgeSession";

/** Where this device keeps its pairing secret: the plugin wires Obsidian's per-device storage into it. */
export interface BridgeTokenStore {
	load(): unknown;
	save(token: string): void;
}

const TOKEN_KEY = "handwriting-bridge-token";

/** Obsidian's per-device storage as a token store. `app` may be absent on a bare test instance. */
export function bridgeTokenStore(app: App | undefined): BridgeTokenStore | undefined {
	if (!app) return undefined;
	return { load: () => app.loadLocalStorage(TOKEN_KEY) as unknown, save: (token) => app.saveLocalStorage(TOKEN_KEY, token) };
}

let client: BridgeClient | null = null;
let unlisten: (() => void) | null = null;

/** Start or stop the link to match the setting. Calling it again with the same answer does nothing. */
export function applyBridge(on: boolean, version: string, store?: BridgeTokenStore, inWindow?: Window): void {
	const want = on && Platform.isAndroidApp;
	if (want === (client !== null)) return;
	if (!want) {
		client?.stop();
		client = null;
		unlisten?.();
		unlisten = null;
		setBridgeSession(null);
		return;
	}
	// Read only now: off, this runs where there may be no window at all.
	const win = inWindow ?? window;
	// The secret stays on this device: it is what the companion's owner
	// approved, and a vault synced to another tablet must ask there afresh.
	const stored = store?.load();
	const token = isBridgeToken(stored) ? stored : newBridgeToken((bytes) => void win.crypto.getRandomValues(bytes));
	if (token !== stored) store?.save(token);
	const started: BridgeClient = new BridgeClient({
		token,
		open: (url) => new (win as unknown as { WebSocket: new (url: string) => unknown }).WebSocket(url) as BridgeSocket,
		timers: { set: (fn, ms) => win.setTimeout(fn, ms), clear: (handle) => win.clearTimeout(handle as number) },
		version,
		onMessage: (message) => session.handle(message),
		onState: (state) => (state === "ready" ? session.connectionOpened() : session.connectionClosed()),
	});
	const session = new BridgeSession((message) => started.send(message), () => win.performance.now());
	client = started;
	setBridgeSession(session, (fn) => win.requestAnimationFrame(fn));
	// The keyboard rising, a split dragged, the tablet turned: each moves the
	// note without any ink surface being told.
	const moved = (): void => bridgeChanged();
	win.addEventListener("resize", moved);
	win.visualViewport?.addEventListener("resize", moved);
	// Coming back to Obsidian is the likeliest moment for the answer to "is
	// the companion there" to have changed.
	const seen = (): void => {
		if (win.document.visibilityState === "visible") started.nudge();
	};
	win.document.addEventListener("visibilitychange", seen);
	unlisten = () => {
		win.removeEventListener("resize", moved);
		win.visualViewport?.removeEventListener("resize", moved);
		win.document.removeEventListener("visibilitychange", seen);
	};
	started.start();
}

/** For the settings tab: "off", "searching", "pairing" or "ready". */
export function bridgeState(): BridgeState {
	return client?.state ?? "off";
}
