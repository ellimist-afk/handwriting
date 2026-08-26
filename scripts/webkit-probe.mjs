/**
 * Engine capability check for the pen path, run locally.
 *
 * The iOS port hangs on one fact: `pointerrawupdate` is Chromium-only, and the
 * inline surface feeds ink from that event alone. This is the gate a build
 * passes before it goes out to a remote tester.
 *
 * It's a smoke test. Read the limits below before trusting a number out of it.
 *
 * WHAT THIS CAN ANSWER
 *   - does the page run on WebKit without throwing
 *   - do pointer events reach handlers at all, and in what order
 *   - is `setPointerCapture` there, is `getPredictedEvents` there
 *
 * WHAT THIS CANNOT ANSWER
 *   - whether `pointerrawupdate` fires. Playwright injects input over CDP,
 *     which bypasses the raw input pipeline, so the event is absent on
 *     Chromium too. A zero here tells you nothing either way.
 *   - anything about coalescing. Playwright's WebKit is a patched build with
 *     no `getCoalescedEvents` at all, headed or headless. iOS Safari has
 *     shipped it since 18, so a zero here says nothing about the iPad.
 *   - anything about an Apple Pencil: pressure, tilt, hover, palm, input rate.
 *
 * All of those need real hardware. What this gate does is stop a build that
 * crashes on WebKit from reaching a remote tester.
 *
 *   node scripts/webkit-probe.mjs              both engines
 *   node scripts/webkit-probe.mjs webkit       one of them
 *
 * Needs the browser binaries once:  npx playwright install webkit chromium
 */

const ENGINES = ["webkit", "chromium"];

const requested = process.argv[2];
const engines = requested ? [requested] : ENGINES;

for (const name of engines) {
	if (!ENGINES.includes(name)) {
		console.error(`unknown engine "${name}". expected one of: ${ENGINES.join(", ")}`);
		process.exit(2);
	}
}

let playwright;
try {
	playwright = await import("playwright");
} catch {
	console.error("playwright is not installed. run: npm ci");
	process.exit(2);
}

/** Runs inside the page. The advertised surface, for the record only. */
function readApis() {
	const proto = typeof PointerEvent === "function" ? PointerEvent.prototype : {};
	return {
		userAgent: navigator.userAgent,
		devicePixelRatio: window.devicePixelRatio,
		maxTouchPoints: navigator.maxTouchPoints,
		coalescedOnPrototype: typeof proto.getCoalescedEvents === "function",
		predictedOnPrototype: typeof proto.getPredictedEvents === "function",
		pointerCapture: typeof Element.prototype.setPointerCapture === "function",
		// Reported to show it disagrees with reality on Chromium. Never used
		// to decide anything; see PlatformCapabilities.ts for why.
		rawHandlerAdvertised: "onpointerrawupdate" in window,
	};
}

/**
 * Installs counters on a full-page capture box. Driven by real browser input,
 * so the numbers come from the engine itself.
 */
function installCounters() {
	const box = document.createElement("div");
	box.id = "probe";
	box.style.cssText = "position:fixed;inset:0;touch-action:none;";
	document.body.style.margin = "0";
	document.body.appendChild(box);

	const state = {
		move: 0,
		raw: 0,
		down: 0,
		up: 0,
		coalescedTotal: 0,
		coalescedMax: 0,
		coalescedSamples: 0,
		coalescedSeen: false,
		pointerTypes: {},
		firstMoveAt: 0,
		lastMoveAt: 0,
	};
	window.__probe = state;

	const count = (e, key) => {
		state[key]++;
		state.pointerTypes[e.pointerType] = (state.pointerTypes[e.pointerType] ?? 0) + 1;
		if (key === "move" || key === "raw") {
			if (state.firstMoveAt === 0) state.firstMoveAt = e.timeStamp;
			state.lastMoveAt = e.timeStamp;
			if (typeof e.getCoalescedEvents === "function") {
				state.coalescedSeen = true;
				const n = e.getCoalescedEvents().length;
				state.coalescedSamples++;
				state.coalescedTotal += n;
				if (n > state.coalescedMax) state.coalescedMax = n;
			}
		}
	};

	box.addEventListener("pointermove", (e) => count(e, "move"));
	box.addEventListener("pointerdown", (e) => count(e, "down"));
	box.addEventListener("pointerup", (e) => count(e, "up"));
	box.addEventListener("pointerrawupdate", (e) => count(e, "raw"));
}

/**
 * Says nothing about rawupdate support. Synthetic input can't produce that
 * event on either engine, so any verdict here would be wrong in the same way
 * the in-app header was before it started counting events.
 */
function verdict(c) {
	if (c.move === 0 && c.down === 0) {
		return "FAIL: no pointer events arrived at all. the engine or this harness is broken";
	}
	if (c.raw > 0) {
		return `pointer events flow. pointerrawupdate fired ${c.raw} times, which is unusual under synthetic input`;
	}
	return "pointer events flow. rawupdate absent, as expected under injected input on every engine";
}

async function probe(engineName) {
	const browser = await playwright[engineName].launch();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		await page.setContent("<!doctype html><meta charset=utf-8><title>probe</title>");
		const apis = await page.evaluate(readApis);
		await page.evaluate(installCounters);

		// A drag across the box. Small steps at speed are what makes an engine
		// coalesce, so this is the shape of gesture the answer depends on.
		await page.mouse.move(60, 350);
		await page.mouse.down();
		for (let x = 60; x <= 840; x += 6) {
			await page.mouse.move(x, 350 + Math.sin(x / 40) * 60);
		}
		await page.mouse.up();

		const counters = await page.evaluate(() => window.__probe);
		return { apis, counters };
	} finally {
		await browser.close();
	}
}

function report(engineName, { apis, counters }) {
	const span = counters.lastMoveAt - counters.firstMoveAt;
	const rate = span > 0 ? ((counters.move / span) * 1000).toFixed(1) : "n/a";
	const avgCoalesced =
		counters.coalescedSamples > 0
			? (counters.coalescedTotal / counters.coalescedSamples).toFixed(2)
			: "n/a";

	const yn = (v) => (v ? "yes" : "NO");
	console.log(`\n==== ${engineName} ====`);
	console.log(verdict(counters));
	console.log("");
	console.log(`  pointerrawupdate events:  ${counters.raw}`);
	console.log(`  pointermove events:       ${counters.move}`);
	console.log(`  down / up:                ${counters.down} / ${counters.up}`);
	console.log(`  getCoalescedEvents seen:  ${yn(counters.coalescedSeen)}`);
	console.log(`  coalesced per move:       avg ${avgCoalesced}, max ${counters.coalescedMax}`);
	console.log(`  observed move rate:       ${rate} Hz over ${span.toFixed(0)} ms`);
	console.log(`  pointer types:            ${JSON.stringify(counters.pointerTypes)}`);
	console.log("");
	console.log(`  getCoalescedEvents on prototype:  ${yn(apis.coalescedOnPrototype)}`);
	console.log(`  getPredictedEvents on prototype:  ${yn(apis.predictedOnPrototype)}`);
	console.log(`  setPointerCapture:                ${yn(apis.pointerCapture)}`);
	console.log(
		`  onpointerrawupdate advertised:    ${yn(apis.rawHandlerAdvertised)}` +
			"  <- false on chromium, where the event fires anyway"
	);
	console.log(`  devicePixelRatio: ${apis.devicePixelRatio}   maxTouchPoints: ${apis.maxTouchPoints}`);
	console.log(`  userAgent: ${apis.userAgent}`);
}

let failed = false;
for (const name of engines) {
	try {
		report(name, await probe(name));
	} catch (err) {
		failed = true;
		console.error(`\n==== ${name} ====\nfailed: ${err?.message ?? err}`);
		if (String(err).includes("Executable doesn't exist")) {
			console.error(`run: npx playwright install ${name}`);
		}
	}
}

console.log(
	"\nreminder: injected input never produces pointerrawupdate on any engine, so the" +
		"\nzero above tells you nothing. playwright's webkit is a patched build with no" +
		"\ngetCoalescedEvents, so that zero says nothing about ios safari either." +
		"\nrawupdate, coalescing, pressure, tilt, hover, palm and the real pencil sample" +
		"\nrate all need hardware. this gate only shows the engine runs.\n"
);

process.exit(failed ? 1 : 0);
