import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatCapabilities,
	formatHost,
	inkPathVerdict,
	predictionVerdict,
	readCapabilities,
	type HostCapabilities,
	type PlatformCapabilities,
	type PointerApis,
	type PointerObservations,
} from "./PlatformCapabilities";

/**
 * The header exists to answer one question from a device this machine will
 * never run: can inline ink draw here.
 *
 * The regression these guard is the first version of this file, which decided
 * that question with `"onpointerrawupdate" in window`. That is false on
 * Chromium, where the event fires anyway, so the header reported "no
 * rawupdate" on the exact platform the plugin ships for. The verdict is driven
 * by observed events now, and nothing here may reintroduce a feature test.
 */

const desktopObserved: PointerObservations = {
	rawUpdateEvents: 4820,
	moveEvents: 610,
	maxCoalesced: 7,
	coalescedSeen: true,
};

const webkitObserved: PointerObservations = {
	rawUpdateEvents: 0,
	moveEvents: 780,
	maxCoalesced: 4,
	coalescedSeen: true,
};

const thinObserved: PointerObservations = {
	rawUpdateEvents: 0,
	moveEvents: 780,
	maxCoalesced: 1,
	coalescedSeen: true,
};

const bareObserved: PointerObservations = {
	rawUpdateEvents: 0,
	moveEvents: 780,
	maxCoalesced: 0,
	coalescedSeen: false,
};

const untouched: PointerObservations = {
	rawUpdateEvents: 0,
	moveEvents: 0,
	maxCoalesced: 0,
	coalescedSeen: false,
};

const chromiumApis: PointerApis = {
	coalescedEventsOnPrototype: true,
	predictedEventsOnPrototype: true,
	pointerCapture: true,
};

const webkitApis: PointerApis = {
	coalescedEventsOnPrototype: true,
	predictedEventsOnPrototype: false,
	pointerCapture: true,
};

const desktopHost: HostCapabilities = {
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isTablet: false,
	isPhone: false,
	isDesktopApp: true,
};

const ipadHost: HostCapabilities = {
	isMobileApp: true,
	isIosApp: true,
	isAndroidApp: false,
	isTablet: true,
	isPhone: false,
	isDesktopApp: false,
};

function caps(
	observed: PointerObservations,
	apis: PointerApis = webkitApis,
	host: HostCapabilities = desktopHost
): PlatformCapabilities {
	return {
		pluginVersion: "0.13.12",
		apiVersion: "1.13.7",
		devicePixelRatio: 2,
		maxTouchPoints: 5,
		viewportWidth: 1024,
		viewportHeight: 768,
		apis,
		observed,
		host,
	};
}

describe("ink path verdict: decided by events that arrived, never by a feature test", () => {
	it("reports the desktop pipeline once rawupdate events have been seen", () => {
		const v = inkPathVerdict(desktopObserved);
		expect(v).toContain("pointerrawupdate fires here");
		expect(v).toContain("4820");
		expect(v).not.toContain("cannot draw");
	});

	it("refuses to judge before anything has been drawn", () => {
		const v = inkPathVerdict(untouched);
		expect(v).toContain("nothing drawn yet");
		expect(v).not.toContain("cannot draw");
	});

	it("reports the move-fed path and its density on WebKit", () => {
		const v = inkPathVerdict(webkitObserved);
		expect(v).toContain("NO pointerrawupdate");
		expect(v).toContain("move-fed path carries the ink");
		expect(v).toContain("up to 4 coalesced samples");
	});

	it("distinguishes coalescing that returns a single sample from none at all", () => {
		expect(inkPathVerdict(thinObserved)).toContain("at most one");
		expect(inkPathVerdict(bareObserved)).toContain("no getCoalescedEvents on any of them");
	});

	it("warns about coarse strokes whenever moves carry one sample each", () => {
		for (const o of [thinObserved, bareObserved]) {
			expect(inkPathVerdict(o)).toContain("strokes will be coarse");
		}
	});

	it("names the raw-less path on every raw-less observation", () => {
		for (const o of [webkitObserved, thinObserved, bareObserved]) {
			expect(inkPathVerdict(o)).toContain("move-fed path carries the ink");
		}
	});

	it("counts events, so a platform advertising nothing still reads correctly", () => {
		// The Chromium trap: no on-handler exposed, events flowing anyway.
		const chromiumLikeButUnadvertised: PointerObservations = {
			rawUpdateEvents: 12,
			moveEvents: 3,
			maxCoalesced: 0,
			coalescedSeen: false,
		};
		expect(inkPathVerdict(chromiumLikeButUnadvertised)).toContain("fires here");
	});
});

describe("prediction verdict", () => {
	it("picks the chromium backend when getPredictedEvents exists", () => {
		expect(predictionVerdict(chromiumApis)).toContain("chromium");
	});

	it("falls back to extrap otherwise", () => {
		expect(predictionVerdict(webkitApis)).toContain("extrap");
	});
});

describe("host flags", () => {
	it("lists the ipad flags in port-relevant order", () => {
		expect(formatHost(ipadHost)).toBe("mobile, ios, tablet");
	});

	it("does not go blank when nothing is set", () => {
		const none: HostCapabilities = {
			isMobileApp: false,
			isIosApp: false,
			isAndroidApp: false,
			isTablet: false,
			isPhone: false,
			isDesktopApp: false,
		};
		expect(formatHost(none)).toContain("no host flags");
	});
});

describe("the full header", () => {
	it("puts the verdict above the counts, so a pasted report leads with it", () => {
		const text = formatCapabilities(caps(webkitObserved, webkitApis, ipadHost));
		expect(text.indexOf("ink path:")).toBeLessThan(text.indexOf("pointerrawupdate events:"));
	});

	it("carries the versions and the host", () => {
		const text = formatCapabilities(caps(webkitObserved, webkitApis, ipadHost));
		expect(text).toContain("0.13.12");
		expect(text).toContain("1.13.7");
		expect(text).toContain("ios");
	});

	it("reports the advertised surface separately from what was observed", () => {
		const text = formatCapabilities(caps(bareObserved, chromiumApis));
		expect(text).toContain("getCoalescedEvents on prototype:  yes");
		expect(text).toContain("getCoalescedEvents seen:  NO");
	});
});

describe("readCapabilities on a host with no global navigator", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/**
	 * CI pins node 20, which has NO global `navigator`; node 21 added it and
	 * this machine runs 22, so the ordinary gate cannot see this. A bare
	 * `navigator` here throws ReferenceError under CI - and `navigator?.x`
	 * throws too, because optional chaining guards null values, not
	 * UNDECLARED bindings. The release line shipped exactly that in 1.3.11
	 * and its checks went red.
	 */
	it("reports zero touch points instead of throwing", () => {
		vi.stubGlobal("navigator", undefined);
		vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 800, innerHeight: 600 });

		const caps = readCapabilities("1.4.2", desktopHost, "1.12.3", bareObserved);

		expect(caps.maxTouchPoints).toBe(0);
		expect(caps.devicePixelRatio).toBe(2);
	});
});
