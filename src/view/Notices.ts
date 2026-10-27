/**
 * Notices written in blank-line-separated blocks: noticeBlocks splits the message and blockNotice shows each block on
 * its own line. Moved unchanged from main.ts, which imports blockNotice back and re-exports noticeBlocks. No module state.
 */
import { Notice } from "obsidian";

/**
 * A Notice whose blank-line-separated blocks actually render as blocks.
 *
 * `Notice` sets TEXT, and a newline in text does not become a line break
 * without a `white-space` rule we do not own - so a message written in blocks
 * arrives as one run-on line. Alan wants the breaks and the reason is
 * legibility: "i want the line break it helps with visibility" (1.4.13), for
 * this notice and for the boox and ipad hints.
 *
 * One block is still a plain string Notice, so nothing pays for a fragment it
 * does not use. Splits on a blank line only - a single newline inside a block
 * stays inside it, because wrapping is the theme's business and not ours.
 */
/**
 * The blocks a notice message is written in, blank-line separated.
 *
 * Exported and pure so the property Alan actually asked for - that the message
 * ARRIVES as more than one line - is pinned by a test rather than by reading
 * Obsidian's stylesheet. Someone collapsing the string to one line, or a
 * refactor losing the escape, fails `NoticeBlocks.test.ts` instead of shipping
 * a run-on toast nobody notices until a user reports it.
 */
export function noticeBlocks(message: string): string[] {
	return message.split(/\n\s*\n/).filter((s) => s.length > 0);
}

export function blockNotice(message: string, durationMs?: number): Notice {
	const blocks = noticeBlocks(message);
	if (blocks.length < 2) return new Notice(message, durationMs);
	return new Notice(
		createFragment((f) => {
			for (const block of blocks) f.createDiv({ text: block });
		}),
		durationMs
	);
}
