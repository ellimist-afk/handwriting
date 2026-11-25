/**
 * The PDF paths this device saw in its vault, and when.
 *
 * Per path, the span of ticks a PDF was there: `first`, and `last`, which is null while it still is, with that file's
 * size and modified time from the vault's stat. A tick is one listing of the vault, once a session when the layout is
 * ready, or one vault event after that listing. So a file renamed here leaves its old path a tick before it reaches the
 * new one; a file renamed while no session ran is seen at its new name only from the next listing on. A path listed
 * with another size or modified time than its span's holds another file now (one left that name and another took it
 * while no session ran): it is new there from that listing.
 *
 * It answers one question, for a PDF created before this session's listing, when Obsidian reports every file in the
 * vault as created: is its path one the session before never held, in any Unicode form? Then it arrived while no
 * session ran, renamed or moved on another device and synced in. Paths and stat only: nothing here reads a PDF.
 *
 * Kept per vault and per device, in the app's local store, never synced: what this device saw is not what another
 * did. A record that cannot be read is no record, and with none the rule stands as it was. So is one too large to
 * keep, or one the store refuses (a full store is shared by every vault and plugin): for the rest of the session it is
 * off, the stored one cleared, and nothing here throws into the event that told it.
 *
 * Each event after the listing is kept in its own task, in a second small store of the events since the last whole
 * write; the whole record is written at most once a second, at the listing, and at unload, and the events are cleared
 * only once that write returned. A load replays the events onto the record in their order, so a session that stopped
 * before its whole write is read as it left the record. Events that cannot be read make the record none.
 */
import { timerHost } from "../util/RuntimeScheduler";

/** Where the record outlives a restart. */
export interface PdfSeenPathsStore {
	load(): unknown;
	save(saved: string | null): void;
}

/** A PDF in the vault as the vault's stat gives it; -1 for a number the stat did not give. */
export interface SeenPdf {
	path: string;
	size: number;
	mtime: number;
}

interface Span {
	first: number;
	/** The last tick the file was there; null while it still is. */
	last: number | null;
	size: number;
	mtime: number;
}

/** One event since the last whole write: its tick, its path, 1 when a PDF came there (with its stat), 0 when one went. */
type Kept = [tick: number, path: string, came: 0 | 1, size: number, mtime: number];

/** Spans of files gone kept, the newest by `last`; a path dropped answers as no record does. */
export const MOST_GONE_KEPT = 1000;
/** A change after the listing is written this long after the first one waiting, so a burst of events is one write. */
export const SAVE_AFTER_MS = 1000;
/** The most characters the saved record may take; past it none is kept (a vault of some thousands of PDFs). */
export const MOST_SAVED_CHARS = 256 * 1024;
/** The most characters the events since the last whole write may take; an event past it writes the whole record. */
export const MOST_EVENT_CHARS = 32 * 1024;

const isTick = (n: unknown, most: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= most;
const isStat = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= -1;
/** A stat number as kept: -1 when the vault gave none. */
const statNumber = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : -1);
/** A stored value read as JSON when it is text; null for text that is not JSON. */
const parsed = (raw: unknown): unknown => {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
};

/** A vault file's path and stat, as kept here. */
export function seenPdf(file: { path: string; stat?: { size?: unknown; mtime?: unknown } | null }): SeenPdf {
	return { path: file.path, size: statNumber(file.stat?.size), mtime: statNumber(file.stat?.mtime) };
}

/** The same file by its stat; a stat not given never is. */
const sameStat = (a: { size: number; mtime: number }, b: { size: number; mtime: number }) =>
	a.size >= 0 && a.mtime >= 0 && a.size === b.size && a.mtime === b.mtime;

export class PdfSeenPaths {
	private tick = 0;
	private readonly spans = new Map<string, Span>();
	/** This session's listing has run: events count from then on. */
	private listedYet = false;
	/** Too large to keep, or the store refused it: no record for the rest of this session. */
	private off = false;
	private timer: number | null = null;
	/** The events since the last whole write, as the events store holds them. */
	private kept: Kept[] = [];
	/** The events store may hold something: what a load found there, or an event saved since the last clear. */
	private eventsHeld = false;
	/** Every path the loaded record holds, in one Unicode form (NFC), until this session's listing. */
	private readonly folded = new Set<string>();

	/**
	 * `events` keeps each event in its own task until the next whole write. Without it, a change is written only on
	 * the timer.
	 */
	constructor(
		private readonly store: PdfSeenPathsStore,
		private readonly events?: PdfSeenPathsStore
	) {
		let raw: unknown;
		let rawEvents: unknown;
		try {
			raw = store.load();
			rawEvents = events?.load();
		} catch {
			this.turnOff();
			return;
		}
		this.eventsHeld = rawEvents !== null && rawEvents !== undefined;
		const saved = parsed(raw) as { tick?: unknown; spans?: unknown } | null;
		if (!saved || typeof saved !== "object" || !isTick(saved.tick, Number.MAX_SAFE_INTEGER) || !Array.isArray(saved.spans)) return;
		const tick = saved.tick;
		const spans = new Map<string, Span>();
		for (const entry of saved.spans as unknown[]) {
			// One entry not of the shape and the whole record is not trusted.
			if (!Array.isArray(entry) || entry.length !== 5) return;
			const [path, first, last, size, mtime] = entry as unknown[];
			if (typeof path !== "string" || !isTick(first, tick) || spans.has(path) || !isStat(size) || !isStat(mtime)) return;
			if (last !== null && !(isTick(last, tick) && last >= first)) return;
			spans.set(path, { first, last, size, mtime });
		}
		// The events since that record was written, replayed as they ran. One not of the shape, or ticks going down, and
		// the whole record is not trusted. One at a tick the record already holds is in it.
		let at = tick;
		if (this.eventsHeld) {
			const list = parsed(rawEvents);
			if (!Array.isArray(list)) return;
			let order = 1;
			for (const entry of list as unknown[]) {
				if (!Array.isArray(entry) || entry.length !== 5) return;
				const [t, path, came, size, mtime] = entry as unknown[];
				if (!isTick(t, Number.MAX_SAFE_INTEGER) || t < order || typeof path !== "string") return;
				if ((came !== 0 && came !== 1) || !isStat(size) || !isStat(mtime)) return;
				order = t;
				if (t <= tick) continue;
				if (came === 1) spans.set(path, { first: t, last: null, size, mtime });
				else {
					const span = spans.get(path);
					if (span?.last === null) span.last = t - 1;
				}
				at = t;
			}
		}
		// The next tick comes after every event replayed.
		this.tick = at;
		for (const [path, span] of spans) {
			this.spans.set(path, span);
			this.folded.add(path.normalize("NFC"));
		}
	}

	/**
	 * The vault's PDFs when the layout is ready, once a session: a file gone since the session before left at its last
	 * tick; one here that was not, or was gone, or is not the file that was (another size or modified time), arrives
	 * now. Written at once.
	 */
	listed(files: readonly SeenPdf[]): void {
		if (this.listedYet || this.off) return;
		this.listedYet = true;
		this.folded.clear();
		this.tick++;
		const here = new Map(files.map((f) => [f.path, f]));
		for (const [path, span] of this.spans) {
			if (span.last === null && !here.has(path)) span.last = this.tick - 1;
		}
		for (const [path, file] of here) {
			const span = this.spans.get(path);
			if (span?.last === null && sameStat(span, file)) continue;
			this.spans.set(path, { first: this.tick, last: null, size: file.size, mtime: file.mtime });
		}
		this.write();
	}

	/** A PDF created after the listing: a file new here. */
	arrived(file: SeenPdf): void {
		if (!this.listedYet || this.off) return;
		this.tick++;
		this.spans.set(file.path, { first: this.tick, last: null, size: file.size, mtime: file.mtime });
		this.changed([[this.tick, file.path, 1, file.size, file.mtime]]);
	}

	/** The PDF at `path` deleted after the listing. */
	left(path: string): void {
		if (!this.listedYet || this.off) return;
		const span = this.spans.get(path);
		if (!span || span.last !== null) return;
		this.tick++;
		span.last = this.tick - 1;
		this.changed([[this.tick, path, 0, -1, -1]]);
	}

	/** A PDF renamed after the listing: gone from `from` a tick before it is at its new path. */
	renamed(from: string, to: SeenPdf): void {
		if (!this.listedYet || this.off) return;
		this.tick++;
		const old = this.spans.get(from);
		if (old && old.last === null) old.last = this.tick - 1;
		this.spans.set(to.path, { first: this.tick, last: null, size: to.size, mtime: to.mtime });
		this.changed([
			[this.tick, from, 0, -1, -1],
			[this.tick, to.path, 1, to.size, to.mtime],
		]);
	}

	/**
	 * Before this session's listing: is `path` one the session before's record never held, in either Unicode form? A
	 * PDF created then at such a path arrived while no session ran. A path the record holds, its file there or gone,
	 * whatever its stat, is not. False with no record, one that cannot be read, one off, and after the listing.
	 */
	unknownBeforeListing(path: string): boolean {
		if (this.off || this.listedYet || this.tick < 1) return false;
		return !this.folded.has(path.normalize("NFC"));
	}

	/** A change still waiting on its timer is written now (unload). */
	flush(): void {
		if (this.timer === null) return;
		this.write();
	}

	/**
	 * An event after the listing: kept in the events store in this task, and the whole record written on the timer.
	 * Events past their cap write the whole record now instead.
	 */
	private changed(entries: Kept[]): void {
		if (this.events) {
			this.kept.push(...entries);
			const saved = JSON.stringify(this.kept);
			if (saved.length > MOST_EVENT_CHARS) {
				this.write();
				return;
			}
			try {
				this.events.save(saved);
			} catch {
				this.turnOff();
				return;
			}
			this.eventsHeld = true;
		}
		if (this.timer !== null) return;
		this.timer = timerHost().setTimeout(() => {
			this.timer = null;
			this.write();
		}, SAVE_AFTER_MS);
	}

	/** The whole record, which holds every change still waiting: its timer is done with, and its events once saved. */
	private write(): void {
		if (this.off) return;
		if (this.timer !== null) {
			timerHost().clearTimeout(this.timer);
			this.timer = null;
		}
		const gone = [...this.spans].filter(([, s]) => s.last !== null).sort(([, a], [, b]) => b.last! - a.last!);
		for (const [path] of gone.slice(MOST_GONE_KEPT)) this.spans.delete(path);
		const saved = JSON.stringify({
			tick: this.tick,
			spans: [...this.spans].map(([path, s]) => [path, s.first, s.last, s.size, s.mtime]),
		});
		if (saved.length > MOST_SAVED_CHARS) {
			this.turnOff();
			return;
		}
		try {
			this.store.save(saved);
		} catch {
			this.turnOff();
			return;
		}
		this.kept = [];
		if (!this.events || !this.eventsHeld) return;
		this.eventsHeld = false;
		try {
			this.events.save(null);
		} catch {
			// Events left stored are at ticks the record now holds; a load passes over them.
		}
	}

	/** No record for the rest of this session, and none left stored for the next to trust. */
	private turnOff(): void {
		this.off = true;
		this.spans.clear();
		this.folded.clear();
		this.kept = [];
		if (this.timer !== null) {
			timerHost().clearTimeout(this.timer);
			this.timer = null;
		}
		for (const store of [this.store, this.events]) {
			try {
				store?.save(null);
			} catch {
				// A store that cannot clear the key leaves what it holds; the next session reads it as the session before's.
			}
		}
	}
}
