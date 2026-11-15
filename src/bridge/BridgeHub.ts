/**
 * The one session the ink surfaces share, and the only thing in `src/bridge/`
 * a surface imports.
 *
 * A surface must behave exactly as it always has when the companion setting
 * is off, so every entry point here answers "no" or does nothing while there
 * is no session. Nothing in a pen path needs to ask whether the feature is
 * on; it asks the question it actually has.
 */
import type { BridgeSession, BridgeSurface } from "./BridgeSession";

let session: BridgeSession | null = null;
let schedule: ((fn: () => void) => void) | null = null;
let pending = false;

/** Install or remove the session. `defer` runs a callback soon, once: an animation frame in the plugin. */
export function setBridgeSession(next: BridgeSession | null, defer: ((fn: () => void) => void) | null = null): void {
	session = next;
	schedule = defer;
	pending = false;
}

export function bridgeSession(): BridgeSession | null {
	return session;
}

/** This surface is where the pen is. */
export function bridgeAttach(surface: BridgeSurface): void {
	session?.attach(surface);
}

/** This surface is on screen: it is where the pen will be unless another surface already is. */
export function bridgeOffer(surface: BridgeSurface): void {
	if (session && !session.hasSurface) session.attach(surface);
}

/** This surface is going away. */
export function bridgeDetach(surface: BridgeSurface): void {
	session?.detach(surface);
}

/**
 * Something the companion was told may no longer be true: the surface moved,
 * the toolbar moved, the tool changed. Any number of calls before the next
 * frame become one message at most.
 */
export function bridgeChanged(): void {
	if (!session || pending) return;
	if (!schedule) {
		session.sync();
		return;
	}
	pending = true;
	const forSession = session;
	schedule(() => {
		pending = false;
		if (session === forSession) forSession.sync();
	});
}

/** Whether the companion is delivering the pen contact a surface is looking at. See `BridgeSession.takeContact`. */
export function bridgeTakesContact(): boolean {
	return session?.takeContact() ?? false;
}
