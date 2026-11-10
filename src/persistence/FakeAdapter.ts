import type { PageAdapterLike } from "./PageStore";

/**
 * Test-only in-memory vault adapter for the persistence suites: a fake
 * filesystem with fault injection (failing writes/renames) and gates that
 * hold an operation open so a race can be staged deterministically.
 *
 * Lives under src/ so it is typechecked with the tests. Nothing the plugin
 * bundle imports references it.
 */
export class FakeAdapter implements PageAdapterLike {
	files = new Map<string, string>();
	mtimes = new Map<string, number>();
	dirs = new Set<string>();
	clock = 1000;
	/** Every mutating call, in order: `write <p>`, `rename <a> -> <b>`, `remove <p>`. */
	log: string[] = [];
	/** Writes that reached the adapter, counted BEFORE any gate or failure. */
	writeAttempts = 0;

	failWriteTimes = 0;
	failRenameTimes = 0;
	failRenameWhen: (from: string, to: string) => boolean = () => true;
	/**
	 * Opt-in: a rename onto a path that already holds a file is refused, as the
	 * desktop vault adapter refuses it. Off by default, so a rename overwrites.
	 */
	refuseRenameOntoFile = false;

	/** While set, the operation waits on the promise before doing anything. */
	readGate: Promise<void> | null = null;
	writeGate: Promise<void> | null = null;
	renameGate: Promise<void> | null = null;

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}

	async read(path: string): Promise<string> {
		if (this.readGate) await this.readGate;
		const f = this.files.get(path);
		if (f === undefined) throw new Error(`ENOENT ${path}`);
		return f;
	}

	async write(path: string, data: string): Promise<void> {
		this.writeAttempts++;
		if (this.writeGate) await this.writeGate;
		if (this.failWriteTimes > 0) {
			this.failWriteTimes--;
			throw new Error("EIO injected");
		}
		this.files.set(path, data);
		this.mtimes.set(path, ++this.clock);
		this.log.push(`write ${path}`);
	}

	async rename(from: string, to: string): Promise<void> {
		if (this.renameGate) await this.renameGate;
		if (this.failRenameTimes > 0 && this.failRenameWhen(from, to)) {
			this.failRenameTimes--;
			throw new Error(`EPERM injected rename ${from} -> ${to}`);
		}
		const f = this.files.get(from);
		if (f === undefined) throw new Error(`ENOENT ${from}`);
		if (this.refuseRenameOntoFile && this.files.has(to)) throw new Error(`EEXIST rename ${from} -> ${to}`);
		this.files.delete(from);
		this.files.set(to, f);
		this.mtimes.set(to, this.mtimes.get(from) ?? ++this.clock);
		this.mtimes.delete(from);
		this.log.push(`rename ${from} -> ${to}`);
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.mtimes.delete(path);
		this.log.push(`remove ${path}`);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}

	/** The file's modified time and its size, as the vault adapter answers them (size in code units: the fixtures are ASCII). */
	async stat(path: string): Promise<{ mtime: number; size?: number } | null> {
		const f = this.files.get(path);
		return f === undefined ? null : { mtime: this.mtimes.get(path)!, size: f.length };
	}

	/** An external process or sync tool dropping bytes into the folder. */
	externalWrite(path: string, data: string): void {
		this.files.set(path, data);
		this.mtimes.set(path, ++this.clock);
	}

	/** A sync tool setting the modified time it carried from the other device, as Obsidian's write option `mtime` does. */
	setMtime(path: string, mtime: number): void {
		if (!this.files.has(path)) throw new Error(`ENOENT ${path}`);
		this.mtimes.set(path, mtime);
	}

	writes(): string[] {
		return this.log.filter((l) => l.startsWith("write "));
	}
}

/** A gate: hand `promise` to an adapter field, call `release` to let it through. */
export function gate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((r) => (release = r));
	return { promise, release };
}
