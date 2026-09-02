/**
 * Choose a free name and create it, racing nobody.
 *
 * `Vault.create`/`Vault.createBinary` throw when the path already exists
 * (obsidian.d.ts: "@throws Error if file already exists"), which is what
 * makes a bounded retry possible here at all - unlike the old
 * `firstFreePath` then `vault.adapter.write*` pattern (main.ts, pre-1.4.6),
 * where checking existence and writing were two separate awaits with a gap
 * between them. Two exports started close together could both see the same
 * name as free and the second `adapter.write*` would silently overwrite the
 * first - the exact failure `firstFreePath`'s own comment promised would not
 * happen.
 *
 * `choose` is asked again on every attempt (not just once, memoized) because
 * the reason for the retry - somebody else just took the name `choose` is
 * about to hand back - is precisely what makes re-asking necessary.
 *
 * On the "already exists" detection: `create` was left free to throw ANY
 * error rather than being matched against Obsidian's message text. The real
 * Vault's error is documented only as "Error if file already exists" with no
 * message contract, and the vitest stub (test/obsidian-stub.ts) does not
 * model `vault.create` at all, so there is nothing here to pattern-match
 * against with any confidence. Retrying on any create failure (short of the
 * last attempt, where it rethrows) costs nothing extra in the common case -
 * a non-existence error is not expected to become creatable by choosing a
 * different name, so it will keep failing until the bound is spent and then
 * surface exactly as it would have on the first try.
 *
 * The price of that is real and was weighed (1.4.6-design.md §5k/e): a
 * read-only vault, a full disk, a sync provider holding the folder - none of
 * those are collisions, and each spends all eight `choose`/`create` rounds
 * before the user is told anything. Eight rounds of two awaits is not a wait
 * anybody notices, and the alternative is matching error text that has no
 * contract, so the cost stays.
 */
export async function createFreshFile<T>(
	choose: () => Promise<string>,
	create: (path: string) => Promise<T>,
	attempts = 8
): Promise<{ path: string; result: T }> {
	for (let attempt = 1; ; attempt++) {
		const path = await choose();
		try {
			const result = await create(path);
			return { path, result };
		} catch (error) {
			if (attempt >= attempts) throw error;
		}
	}
}
