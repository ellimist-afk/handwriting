import { App, Modal, Notice } from "obsidian";
import {
	FORK_COPY_PLACEHOLDER as COPY,
	ForkAccount,
	ForkDecision,
	ForkHost,
	ForkRecord,
	applyForkDecision,
	describeFork,
	listForks,
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
			if (shown.has(r.pageId)) continue;
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
		side(COPY.mine, a.mine, a.mineOnly);
		side(COPY.theirs, a.theirs, a.theirsOnly);

		const buttons = box.createDiv({ cls: "handwriting-fork-actions" });
		this.button(buttons, COPY.keepMine, rec, "keep-mine");
		this.button(buttons, COPY.takeTheirs, rec, "take-theirs");
		this.button(buttons, COPY.keepBoth, rec, "keep-both");
	}

	private button(parent: HTMLElement, text: string, rec: ForkRecord, decision: ForkDecision): void {
		const btn = parent.createEl("button", { text });
		btn.addEventListener("click", () => {
			btn.setAttribute("disabled", "true");
			void applyForkDecision(this.host, rec, decision)
				.then((out) => {
					if (out.kind === "refused") {
						new Notice(COPY.refused);
						btn.removeAttribute("disabled");
						return;
					}
					// Re-render from the register rather than mutating the DOM
					// in place: the decision may have left the fork listed
					// (keep both) or removed it, and the list is the truth.
					void this.onOpen();
				})
				.catch((err) => {
					console.error("[handwriting] fork decision failed", rec.pageId, err);
					btn.removeAttribute("disabled");
				});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
