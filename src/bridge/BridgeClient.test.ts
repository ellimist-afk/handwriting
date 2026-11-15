/**
 * The socket lifecycle on a fake socket and a fake clock: no network, no real
 * timer. Each test drives the events a WebSocket would deliver and reads what
 * the client sent and what state it reported.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeClient, RETRY_MS, WELCOME_TIMEOUT_MS, type BridgeSocket, type BridgeState } from "./BridgeClient";
import type { BridgeIn } from "./BridgeProtocol";

class FakeSocket implements BridgeSocket {
	sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
	}
}

class FakeTimers {
	private next = 1;
	readonly pending = new Map<number, { fn: () => void; ms: number }>();
	set = (fn: () => void, ms: number): unknown => {
		this.pending.set(this.next, { fn, ms });
		return this.next++;
	};
	clear = (handle: unknown): void => {
		this.pending.delete(handle as number);
	};
	/** Fire the one pending timer, and say how long it was set for. */
	fire(): number {
		expect(this.pending.size).toBe(1);
		const [handle, timer] = [...this.pending.entries()][0]!;
		this.pending.delete(handle);
		timer.fn();
		return timer.ms;
	}
}

const WELCOME = JSON.stringify({ type: "welcome", protocol: 1, app: "boox-ink-bridge", version: "0.1.0" });

describe("BridgeClient", () => {
	let sockets: FakeSocket[];
	let timers: FakeTimers;
	let states: BridgeState[];
	let messages: BridgeIn[];
	let client: BridgeClient;
	const last = (): FakeSocket => sockets[sockets.length - 1]!;

	beforeEach(() => {
		sockets = [];
		timers = new FakeTimers();
		states = [];
		messages = [];
		client = new BridgeClient({
			open: (url) => {
				const s = new FakeSocket(url);
				sockets.push(s);
				return s;
			},
			timers,
			version: "9.9.9",
			token: "t".repeat(32),
			onMessage: (m) => messages.push(m),
			onState: (s) => states.push(s),
		});
	});

	const connect = (): FakeSocket => {
		client.start();
		const s = last();
		s.onopen?.();
		s.onmessage?.({ data: WELCOME });
		return s;
	};

	it("says hello on open and is ready only after the welcome", () => {
		client.start();
		expect(last().url).toBe("ws://127.0.0.1:47810/");
		last().onopen?.();
		expect(JSON.parse(last().sent[0]!)).toEqual({ type: "hello", protocol: 1, client: "handwriting", version: "9.9.9", token: "t".repeat(32) });
		expect(client.state).toBe("searching");
		expect(client.send({ type: "resume" })).toBe(false);
		last().onmessage?.({ data: WELCOME });
		expect(client.state).toBe("ready");
		expect(states).toEqual(["searching", "ready"]);
		expect(timers.pending.size).toBe(0);
		expect(client.send({ type: "resume" })).toBe(true);
	});

	it("tries the second port when the first refuses, then waits", () => {
		client.start();
		last().onerror?.();
		expect(sockets.map((s) => s.url)).toEqual(["ws://127.0.0.1:47810/", "ws://127.0.0.1:47811/"]);
		last().onclose?.();
		expect(sockets.length).toBe(2);
		expect(timers.fire()).toBe(RETRY_MS[0]);
		expect(sockets.length).toBe(3);
		expect(last().url).toBe("ws://127.0.0.1:47810/");
	});

	it("waits longer each round, up to the ceiling", () => {
		client.start();
		const waits: number[] = [];
		for (let round = 0; round < RETRY_MS.length + 2; round++) {
			last().onerror?.();
			last().onerror?.();
			waits.push(timers.fire());
		}
		expect(waits).toEqual([...RETRY_MS, RETRY_MS[RETRY_MS.length - 1], RETRY_MS[RETRY_MS.length - 1]]);
	});

	it("treats a silent server as absent", () => {
		client.start();
		last().onopen?.();
		expect(timers.fire()).toBe(WELCOME_TIMEOUT_MS);
		expect(sockets[0]!.closed).toBe(true);
		expect(sockets.length).toBe(2);
		expect(client.state).toBe("searching");
	});

	it("reports pairing when the companion turns it away, and is ready once it is let in", () => {
		client.start();
		last().onopen?.();
		last().onmessage?.({ data: '{"type":"denied","reason":"pairing"}' });
		expect(client.state).toBe("pairing");
		expect(messages).toEqual([]);
		last().onclose?.();
		expect(client.state).toBe("pairing");
		// The second port is tried, then the ordinary wait; the next round is let in.
		last().onerror?.();
		timers.fire();
		last().onopen?.();
		last().onmessage?.({ data: WELCOME });
		expect(client.state).toBe("ready");
		expect(states).toEqual(["searching", "pairing", "ready"]);
	});

	it("ignores a welcome for a protocol it does not speak", () => {
		client.start();
		last().onopen?.();
		last().onmessage?.({ data: JSON.stringify({ type: "welcome", protocol: 2, app: "x", version: "x" }) });
		expect(client.state).toBe("searching");
	});

	it("passes on messages only once ready, and never the welcome", () => {
		client.start();
		const s = last();
		s.onopen?.();
		s.onmessage?.({ data: '{"type":"stroke-begin","id":1,"rev":1}' });
		expect(messages).toEqual([]);
		s.onmessage?.({ data: WELCOME });
		s.onmessage?.({ data: '{"type":"stroke-begin","id":2,"rev":1}' });
		s.onmessage?.({ data: "garbage" });
		expect(messages).toEqual([{ type: "stroke-begin", id: 2, rev: 1 }]);
	});

	it("looks again from the first port after losing a companion it had", () => {
		const s = connect();
		s.onclose?.();
		expect(client.state).toBe("searching");
		expect(states).toEqual(["searching", "ready", "searching"]);
		expect(timers.fire()).toBe(RETRY_MS[0]);
		expect(last().url).toBe("ws://127.0.0.1:47810/");
	});

	it("nudge skips the wait, and does nothing while connected or connecting", () => {
		client.start();
		client.nudge();
		expect(sockets.length).toBe(1);
		last().onerror?.();
		last().onerror?.();
		expect(timers.pending.size).toBe(1);
		client.nudge();
		expect(timers.pending.size).toBe(0);
		expect(sockets.length).toBe(3);
	});

	it("stop closes the socket, cancels every timer and stays stopped", () => {
		const s = connect();
		client.stop();
		expect(s.closed).toBe(true);
		expect(client.state).toBe("off");
		expect(timers.pending.size).toBe(0);
		s.onclose?.();
		expect(sockets.length).toBe(1);
		expect(client.send({ type: "resume" })).toBe(false);
	});

	it("a socket constructor that throws counts as a refusal", () => {
		const throwing = new BridgeClient({
			open: () => {
				throw new Error("blocked");
			},
			timers,
			version: "1",
			token: "t".repeat(32),
			onMessage: () => {},
			onState: () => {},
		});
		throwing.start();
		expect(timers.pending.size).toBe(1);
	});
});
