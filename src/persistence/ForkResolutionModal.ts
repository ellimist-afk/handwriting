import { App, Modal, Notice } from "obsidian";
import {
	FORK_COPY_PLACEHOLDER as COPY,
	ForkAccount,
	ForkDecision,
	ForkHost,
	ForkRecord,
	applyForkDecision,
	describeFork,
	forkLabels,
	listForks,
	refusalFor,
} from "./ForkResolution";

/**
 * The list of notes waiting for a decision, and the three ways to answer.
 *
 * EVERY STRING HERE IS ALAN'S AND APPROVED. They live in
 * `FORK_COPY_PLACEHOLDER`, which is where to change one - not here. THE
 * AUTHORITY IS THE RECORDED DECISION, not this comment: the ten words were approved in
 * the entry stamped 2026-09-09 10:04 CDT, and the trailing period was removed
 * from `headline` by the 17:09 CDT ruling the same day. Both are in
 * that decision.
 *
 * `ForkCopyApproved.test.ts` pins all ten verbatim and reds if any is
 * reworded, so a change to the wording is a decision that goes back to him
 * rather than an edit.
 *
 * The exceptions are the defaults in `FORK_COPY_DEFAULTS`: words he was asked
 * for and had no words for, shown where his would be untrue (a pair this
 * device cannot place) or wrong (a refused take-the-other). They are pinned as
 * a second list and are his to change on sight.
 *
 * The modal owns no logic. It asks `describeFork` what each side holds and
 * hands the user's choice to `applyForkDecision`; both are executed under test
 * without an app. What is here is the part that needs a screen.
 */
export class ForkResolutionModal extends Modal {
	constructor(
		app: App,
		private readonly host: ForkHost,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		// Newest first, so the first pair kept for a page is its newest.
		const records = listForks();
		const open: Array<{ rec: ForkRecord; account: ForkAccount }> = [];
		const shown = new Set<string>();
		for (const r of records) {
			// A kept copy is described even on a page already shown: one this
			// build cannot read is listed beside the page's decision.
			if (shown.has(r.pageId) && !r.kept) continue;
			let account: ForkAccount;
			try {
				account = await describeFork(this.host, r);
			} catch (err) {
				// One unreadable pair must not hide the rest of the list.
				console.error("[handwriting] could not describe a preserved fork", r.pageId, err);
				continue;
			}
			// Only the ones with something to decide. Older pairs with nothing
			// to decide are not listed and not deleted. A page can hold several
			// pairs; the newest one that needs a decision is the one put to the
			// user, and a later routine pair no longer hides it.
			if (!account.needsDecision) continue;
			// It cannot be decided here, so it does not take the page's one place
			// from a pair or copy that can.
			if (account.undecidable) {
				open.push({ rec: r, account });
				continue;
			}
			if (shown.has(r.pageId)) continue;
			shown.add(r.pageId);
			open.push({ rec: r, account });
		}

		if (open.length === 0) {
			contentEl.createEl("p", { text: COPY.empty });
			return;
		}

		for (const { rec, account } of open) this.renderOne(contentEl, account, rec);
	}

	private renderOne(parent: HTMLElement, a: ForkAccount, rec: ForkRecord): void {
		const box = parent.createDiv({ cls: "handwriting-fork" });
		box.createEl("h3", { text: a.path });
		box.createEl("p", { text: COPY.headline });

		const side = (label: string, s: ForkAccount["mine"], only: number): void => {
			const line = s.readable
				? `${label}: ${s.strokes} strokes, ${only} not in the other, modified ${new Date(s.mtime).toLocaleString()}`
				: `${label}: ${COPY.unreadable}`;
			box.createEl("p", { text: line });
		};
		// A pair this device cannot place names its sides Version A and B.
		const words = forkLabels(rec);
		side(words.mine, a.mine, a.mineOnly);
		side(words.theirs, a.theirs, a.theirsOnly);

		const row = box.createDiv({ cls: "handwriting-fork-actions" });
		const choices: Array<[string, ForkDecision]> = [
			[words.keepMine, "keep-mine"],
			[words.takeTheirs, "take-theirs"],
			[words.keepBoth, "keep-both"],
		];
		const buttons = choices.map(([text]) => row.createEl("button", { text }));
		choices.forEach(([, decision], i) => this.wire(buttons, buttons[i]!, rec, decision));
	}

	/**
	 * One of the pair's three buttons. While its decision runs, all three are
	 * disabled, so the pair cannot be asked a second question meanwhile.
	 */
	private wire(all: HTMLElement[], btn: HTMLElement, rec: ForkRecord, decision: ForkDecision): void {
		const enable = (on: boolean): void => {
			for (const b of all) {
				if (on) b.removeAttribute("disabled");
				else b.setAttribute("disabled", "true");
			}
		};
		btn.addEventListener("click", () => {
			enable(false);
			void applyForkDecision(this.host, rec, decision)
				.then((out) => {
					if (out.kind === "refused") {
						new Notice(refusalFor(rec, decision));
						enable(true);
						return;
					}
					// Another decision on this page was running, or the pair is no
					// longer listed: nothing happened, and nothing is said.
					if (out.kind === "ignored") {
						enable(true);
						return;
					}
					// Re-render from the register rather than mutating the DOM
					// in place: the decision may have left the fork listed
					// (keep both) or removed it, and the list is the truth.
					void this.onOpen();
				})
				.catch((err) => {
					console.error("[handwriting] fork decision failed", rec.pageId, err);
					enable(true);
				});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
