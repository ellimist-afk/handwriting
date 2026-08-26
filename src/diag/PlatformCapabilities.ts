/**
 * What this platform can actually deliver to the pen path, printed at the top
 * of every diagnostics export.
 *
 * The iOS port turned on one fact: `pointerrawupdate` is Chromium-only, and
 * the inline surface fed ink from that event alone. On WebKit the event never
 * fires, so a build that installed cleanly and looked healthy produced no ink
 * at all (proved on hardware 2026-08-25: 0 raw in 303 move events, up to 4
 * coalesced samples per move). Since then the router inks from `pointermove`'s
 * coalesced list whenever no raw has ever arrived in the session (InkFeed.ts),
 * so the verdict now names which path carries the ink and at what density. A
 * remote tester can't be asked to spot any of that, so the report says it in
 * its first lines instead of leaving it buried in event counts.
 *
 * THE VERDICT IS OBSERVED, NOT FEATURE-DETECTED. The obvious check,
 * `"onpointerrawupdate" in window`, is false on Chromium: the event fires and
 * the plugin's whole desktop pipeline depends on it, but no `on*` IDL
 * attribute is exposed for it, on Window or on Element. A header built on that
 * check printed "pointerrawupdate: NO" on the Surface this plugin ships for.
 * There's no reliable feature test, so the report counts the events that
 * actually arrived. What the header needs to report is whether samples reached
 * the handler, which is what that count says.
 *
 * Split the way GuardStyle and FollowLayer are, and for the same reason: no
 * `obsidian` import anywhere in this file, so the whole thing loads under
 * vitest. `Platform` and `apiVersion` arrive as arguments from the view, which
 * already imports them. `readCapabilities` is the only function here that
 * touches globals, and it's the only part the tests don't cover.
 */

/**
 * Advertised API surface. Reported for the record; only `pointerCapture` and
 * the prediction backend choice are decided from these. See the header note on
 * why `pointerrawupdate` is deliberately absent from this list.
 */
export interface PointerApis {
	/** `PointerEvent.prototype.getCoalescedEvents`. */
	coalescedEventsOnPrototype: boolean;
	/** `PointerEvent.prototype.getPredictedEvents`. Prediction's "chromium" backend. */
	predictedEventsOnPrototype: boolean;
	/** `Element.setPointerCapture`. The stroke frame depends on it. */
	pointerCapture: boolean;
}

/** What actually arrived at the handlers during the session. */
export interface PointerObservations {
	/** `pointerrawupdate` events seen. Zero on WebKit; thousands on Chromium. */
	rawUpdateEvents: number;
	/** `pointermove` events seen. Zero means nobody has drawn yet. */
	moveEvents: number;
	/** Largest `getCoalescedEvents().length` seen on a real event. */
	maxCoalesced: number;
	/** Whether any real event carried `getCoalescedEvents` at all. */
	coalescedSeen: boolean;
}

export interface HostCapabilities {
	isMobileApp: boolean;
	isIosApp: boolean;
	isAndroidApp: boolean;
	isTablet: boolean;
	isPhone: boolean;
	isDesktopApp: boolean;
}

export interface PlatformCapabilities {
	pluginVersion: string;
	apiVersion: string;
	userAgent: string;
	devicePixelRatio: number;
	maxTouchPoints: number;
	viewportWidth: number;
	viewportHeight: number;
	apis: PointerApis;
	observed: PointerObservations;
	host: HostCapabilities;
}

/**
 * The verdict line. This is the sentence the remote session is run to produce,
 * so it says what happens to ink instead of which API is missing. Before
 * anything has been drawn it says that, and stops there.
 */
export function inkPathVerdict(o: PointerObservations): string {
	if (o.rawUpdateEvents > 0) {
		return (
			`ink path: pointerrawupdate fires here (${o.rawUpdateEvents} events). ` +
			"the desktop pipeline applies unchanged"
		);
	}
	if (o.moveEvents === 0) {
		return "ink path: nothing drawn yet. draw in the capture box before reading this";
	}
	if (o.maxCoalesced > 1) {
		return (
			`ink path: NO pointerrawupdate in ${o.moveEvents} move events. the move-fed ` +
			`path carries the ink here, up to ${o.maxCoalesced} coalesced samples per move`
		);
	}
	if (o.coalescedSeen) {
		return (
			`ink path: NO pointerrawupdate in ${o.moveEvents} move events. the move-fed ` +
			"path carries the ink here at one sample per move (getCoalescedEvents returned " +
			"at most one), so strokes will be coarse"
		);
	}
	return (
		`ink path: NO pointerrawupdate in ${o.moveEvents} move events, and no ` +
		"getCoalescedEvents on any of them. the move-fed path carries the ink here at " +
		"one sample per move, so strokes will be coarse"
	);
}

/** Which prediction backend `Prediction.ts` will end up selecting here. */
export function predictionVerdict(a: PointerApis): string {
	return a.predictedEventsOnPrototype
		? 'prediction: getPredictedEvents present, so the "chromium" backend is available'
		: 'prediction: no getPredictedEvents, so it falls back to the "extrap" backend';
}

function yesNo(v: boolean): string {
	return v ? "yes" : "NO";
}

/** The host flags, as a single line, in the order that matters for the port. */
export function formatHost(h: HostCapabilities): string {
	const flags: string[] = [];
	if (h.isDesktopApp) flags.push("desktop");
	if (h.isMobileApp) flags.push("mobile");
	if (h.isIosApp) flags.push("ios");
	if (h.isAndroidApp) flags.push("android");
	if (h.isTablet) flags.push("tablet");
	if (h.isPhone) flags.push("phone");
	return flags.length > 0 ? flags.join(", ") : "(no host flags set)";
}

/**
 * The report header. Pure: every value arrives as an argument, so the whole
 * thing is exercised in tests against platforms this machine does not have.
 */
export function formatCapabilities(c: PlatformCapabilities): string {
	return [
		"==== Handwriting platform capabilities ====",
		`plugin: ${c.pluginVersion}   obsidian api: ${c.apiVersion}`,
		`host: ${formatHost(c.host)}`,
		"",
		inkPathVerdict(c.observed),
		predictionVerdict(c.apis),
		"",
		`pointerrawupdate events:  ${c.observed.rawUpdateEvents}`,
		`pointermove events:       ${c.observed.moveEvents}`,
		`max coalesced per event:  ${c.observed.maxCoalesced}`,
		`getCoalescedEvents seen:  ${yesNo(c.observed.coalescedSeen)}`,
		"",
		`getCoalescedEvents on prototype:  ${yesNo(c.apis.coalescedEventsOnPrototype)}`,
		`getPredictedEvents on prototype:  ${yesNo(c.apis.predictedEventsOnPrototype)}`,
		`setPointerCapture:                ${yesNo(c.apis.pointerCapture)}`,
		"",
		`devicePixelRatio: ${c.devicePixelRatio}   maxTouchPoints: ${c.maxTouchPoints}`,
		`viewport: ${c.viewportWidth} x ${c.viewportHeight}`,
		`userAgent: ${c.userAgent}`,
		"==========================================",
	].join("\n");
}

/**
 * Read the live platform. Every lookup is defensive: this runs on hosts the
 * plugin has never been built for, and a probe that throws while collecting
 * its own preamble tells the tester nothing.
 */
export function readCapabilities(
	pluginVersion: string,
	host: HostCapabilities,
	obsidianApiVersion: string,
	observed: PointerObservations
): PlatformCapabilities {
	const proto: Partial<PointerEvent> =
		typeof PointerEvent === "function" ? PointerEvent.prototype : {};
	return {
		pluginVersion,
		apiVersion: obsidianApiVersion || "(unknown)",
		userAgent: navigator?.userAgent ?? "(unknown)",
		devicePixelRatio: window.devicePixelRatio || 1,
		maxTouchPoints: navigator?.maxTouchPoints ?? 0,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
		apis: {
			coalescedEventsOnPrototype: typeof proto.getCoalescedEvents === "function",
			predictedEventsOnPrototype: typeof proto.getPredictedEvents === "function",
			pointerCapture: typeof Element.prototype.setPointerCapture === "function",
		},
		observed,
		host,
	};
}
