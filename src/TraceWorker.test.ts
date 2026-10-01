/**
 * The trace-upload worker: a stored recording is found by its id however many others exist (audit 87),
 * an empty id finds nothing, and anonymous uploads expire and are rate limited per address (audit 148).
 * The real worker module runs against an in-memory stand-in for its KV namespace.
 */
import { describe, expect, it } from "vitest";
import worker from "../scripts/trace-worker/worker.mjs";

interface PutOpts {
	expirationTtl?: number;
}

class FakeKv {
	readonly data = new Map<string, string>();
	readonly ttl = new Map<string, number | undefined>();
	async put(key: string, value: string, opts?: PutOpts): Promise<void> {
		this.data.set(key, value);
		this.ttl.set(key, opts?.expirationTtl);
	}
	async get(key: string): Promise<string | null> {
		return this.data.get(key) ?? null;
	}
	async list(opts: { limit?: number; cursor?: string; prefix?: string } = {}) {
		const all = [...this.data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = Math.min(opts.limit ?? 1000, 1000);
		const keys = all.slice(start, start + limit).map((name) => ({ name }));
		const done = start + limit >= all.length;
		return { keys, list_complete: done, cursor: done ? undefined : String(start + limit) };
	}
}

const SECRET = "s3cret";
const trace = JSON.stringify({ v: 1, events: [] });

function env(kv: FakeKv) {
	return { TRACES: kv, SECRET_KEY: SECRET };
}
function upload(kv: FakeKv, ip = "1.2.3.4", body = trace) {
	return worker.fetch(
		new Request("https://w.example/upload", {
			method: "POST",
			body,
			headers: { "cf-connecting-ip": ip },
		}),
		env(kv)
	);
}
function get(kv: FakeKv, path: string) {
	return worker.fetch(new Request(`https://w.example${path}${path.includes("?") ? "&" : "?"}key=${SECRET}`), env(kv));
}

describe("trace worker lookup", () => {
	it("finds a new upload by its id although more than a thousand older recordings exist", async () => {
		const kv = new FakeKv();
		for (let i = 0; i < 1500; i++) kv.data.set(`2026-01-01-${String(i).padStart(8, "0")}`, trace);
		const res = await upload(kv);
		const { id } = (await res.json()) as { id: string };
		const back = await get(kv, `/r/${id}`);
		expect(back.status).toBe(200);
		expect(await back.text()).toBe(trace);
	});

	it("refuses an empty or fully stripped id instead of returning the first recording", async () => {
		const kv = new FakeKv();
		await upload(kv);
		expect((await get(kv, "/r/")).status).toBe(400);
		expect((await get(kv, "/r/!!!")).status).toBe(400);
	});

	it("does not match an id that is only a fragment of another", async () => {
		const kv = new FakeKv();
		const { id } = (await (await upload(kv)).json()) as { id: string };
		expect((await get(kv, `/r/${id.slice(0, 4)}`)).status).toBe(404);
	});

	it("never lists or serves the per-address upload counters", async () => {
		const kv = new FakeKv();
		const { id } = (await (await upload(kv, "5.6.7.8")).json()) as { id: string };
		const counter = [...kv.data.keys()].find((k) => k.startsWith("rl-"));
		expect(counter, "an upload leaves a counter").toBeDefined();
		const names = (await (await get(kv, "/list")).json()) as string[];
		expect(names).toHaveLength(1);
		expect(names[0]?.endsWith(id)).toBe(true);
		expect((await get(kv, `/r/${(counter as string).replace(/[^a-z0-9-]/gi, "")}`)).status).toBe(404);
	});

	it("lists the newest recordings, newest first, past the first page", async () => {
		const kv = new FakeKv();
		for (let i = 0; i < 1200; i++) kv.data.set(`2026-01-01-${String(i).padStart(8, "0")}`, trace);
		kv.data.set("2026-09-25-ffffffff", trace);
		const names = (await (await get(kv, "/list")).json()) as string[];
		expect(names).toHaveLength(100);
		expect(names[0]).toBe("2026-09-25-ffffffff");
		expect(names.some((n) => n.startsWith("rl-"))).toBe(false);
	});
});

describe("trace worker abuse limits", () => {
	it("stores every recording with an expiry", async () => {
		const kv = new FakeKv();
		const { id } = (await (await upload(kv)).json()) as { id: string };
		const key = [...kv.data.keys()].find((k) => k.endsWith(id));
		expect(key).toBeDefined();
		expect(kv.ttl.get(key as string)).toBeGreaterThan(0);
	});

	it("refuses an address that uploads too often, and only that address", async () => {
		const kv = new FakeKv();
		let last = 200;
		for (let i = 0; i < 40; i++) last = (await upload(kv, "9.9.9.9")).status;
		expect(last).toBe(429);
		expect((await upload(kv, "8.8.8.8")).status).toBe(200);
	});

	it("still refuses a bad body before counting it, and still needs the key to read", async () => {
		const kv = new FakeKv();
		expect((await upload(kv, "1.1.1.1", "nope")).status).toBe(400);
		const res = await worker.fetch(new Request("https://w.example/list"), env(kv));
		expect(res.status).toBe(403);
	});
});
