/**
 * Two phases of HandwritingPlugin.onload, moved from PluginOnload.ts: the ink in rendered markdown (embeds and
 * reading view) and the live reload of ink written elsewhere. Methods of HandwritingPlugin, installed on its prototype
 * when main.ts loads and called by onload in the order the statements had. Bodies moved unchanged.
 */
import { MarkdownRenderChild } from "obsidian";
import { reloadSlidesExternal, slidesReloadCandidate } from "./slides/SlidesInkSurface";
import { captureInlineReloadAdmission, inkExternallyReloaded, inlineInk, inlineReloadCandidates, overlayForPath } from "./inline/InkOverlay";
import { isMarkdownPath } from "./util/MarkdownPath";
import { attachEmbedInkOnceReady, embedInkDiagLine, embedInkIsLiveEditorBlock, initEmbedInkDiagnostics } from "./inline/EmbedInk";
import { notifyInkChanged } from "./inline/InkEvents";
import { PdfInkController } from "./pdf/PdfInkController";
import { runDetached } from "./util/Detached";
import { installMethods } from "./inline/InstallMethods";
import type { HandwritingPlugin } from "./main";

declare module "./main" {
	interface HandwritingPlugin {
		onloadEmbeds(): void;
		onloadLiveReload(): void;
	}
}

/**
 * How many one-second ticks to skip between sidecar checks.
 *
 * One second while ink is arriving, stretching to five when it is not. What
 * is being spread out is a filesystem stat per open document, which is this
 * plugin's largest standing cost when nothing at all is happening - it runs
 * whether or not a second device exists.
 */
function reloadStride(quietTicks: number): number {
	return Math.min(5, 1 + Math.floor(quietTicks / 5));
}

	/** Ink in rendered markdown: the embed diagnostics, the note reader and the markdown post-processor. */
	function onloadEmbeds(this: HandwritingPlugin): void {
		// Ink in rendered markdown: embeds and reading view (roadmap). Each
		// section defers via a render child; on load it finds the rendered
		// root and the first one attaches the single ink layer. See
		// EmbedInk.ts for why "on load" no longer means "attached to the
		// document" - the virtualised preview renderer loads a section's
		// child before inserting the section, so the root is resolved from
		// the section, or the renderer's own container, or by waiting for
		// the section to land. Which of the three applies is a property of
		// the reader's Obsidian, not of ours, so all three are covered.
		//
		// One line per section that resolved (or failed to resolve) a root,
		// naming the route it came by. Off unless developer diagnostics is on,
		// and the LINE is only built when it is - the sink takes the pieces.
		// This exists for reports from machines we cannot get at: it separates
		// "your renderer never gave us a root" from "we attached and drew
		// nothing", which are different bugs with the same symptom.
		initEmbedInkDiagnostics((via, path, waitedMs) => {
			if (!this.settings.devDiagnostics) return;
			console.debug(embedInkDiagLine(via, path, waitedMs));
		});
		const readNoteText = async (notePath: string): Promise<string | null> => {
			const file = this.app.vault.getFileByPath(notePath);
			return file ? this.app.vault.cachedRead(file) : null;
		};
		// The note's sections as the metadata cache holds them, for a render that
		// gives no section info of its own; undefined until the cache has them.
		const noteSections = (notePath: string) => {
			const file = this.app.vault.getFileByPath(notePath);
			return file ? this.app.metadataCache.getFileCache(file)?.sections : undefined;
		};
		// A hover preview post-processes every section of the note, each with
		// its own ctx but the same renderer container. Whether that render is
		// the whole note is one answer for all of them, so it is worked out
		// once per container: a per-section check read and compared the whole
		// file once for every section.
		//
		// The container outlives a render. A popover open while its note is
		// saved renders the old text, compares it with the saved file and is
		// refused; then the same renderer renders the saved text into the same
		// container, post-processing only the sections that changed. So an
		// answer is kept only for the text it was given, and a different text
		// is compared afresh, even while the old comparison is still pending.
		//
		// Asking a render what text it holds costs a walk of the renderer's
		// sections (getSectionInfo scans them in order), so it is asked once
		// per render, not once per section: the sections of one render are
		// post-processed in one synchronous pass, and the answer is marked
		// fresh until that pass has finished.
		const hoverWholeNote = new WeakMap<
			object,
			{ rendered: string; verdict: Promise<boolean>; fresh: boolean }
		>();
		this.registerMarkdownPostProcessor((el, ctx) => {
			const path = ctx.sourcePath;
			if (!path || !isMarkdownPath(path)) return;
			// containerEl is not on MarkdownPostProcessorContext's declared
			// type - it is read off the shipped bundle - so it is duck-typed
			// rather than trusted, and instanceof is avoided on purpose:
			// against a popout's own window it would reject an element that
			// is perfectly real, just not an instance of THIS window's
			// HTMLElement.
			const containerEl = (ctx as { containerEl?: unknown }).containerEl;
			const container =
				containerEl && typeof (containerEl as HTMLElement).closest === "function"
					? (containerEl as HTMLElement)
					: null;
			// Live Preview also postprocesses its own table/callout blocks.
			// They are editor content, not a rendered second view of this note.
			if (embedInkIsLiveEditorBlock(el, container)) return;
			const child = new MarkdownRenderChild(el);
			let cancelRetry: (() => void) | null = null;
			// The child can unload while the sidecar load below is still in
			// flight, and the `.then` would then start a wait nothing holds a
			// canceller for. Recorded rather than inferred from cancelRetry,
			// which is still null at exactly that moment.
			let childUnloaded = false;
			// Where this section's source lines come from, read when the ink is
			// painted, so ink that remembers its line is drawn on its words. A
			// render that gives no section info (an embed, an export) lays the
			// note's cached sections onto its blocks once the note's text is read.
			let noteText: string | null = null;
			let readingText = false;
			const lines = {
				section: () => ctx.getSectionInfo(el),
				cached: (wake: () => void) => {
					const sections = noteSections(path);
					if (!sections) return null;
					if (noteText === null) {
						if (!readingText) {
							readingText = true;
							runDetached(
								readNoteText(path).then((text) => {
									if (text === null || childUnloaded) return;
									noteText = text;
									wake();
								}),
								"read a rendered note's text for its ink"
							);
						}
						return null;
					}
					return {
						sections: sections.map((s) => ({ type: s.type, lineStart: s.position.start.line, lineEnd: s.position.end.line })),
						text: noteText,
					};
				},
			};
			const attach = () => {
				if (childUnloaded) return;
				cancelRetry = attachEmbedInkOnceReady(el, container, path, () =>
					inlineInk.strokes(path),
					// A hover preview rendered the whole note only when the text
					// its renderer holds is the file's own text; a heading or
					// block preview renders a slice of it.
					() => {
						const known = container ? hoverWholeNote.get(container) : undefined;
						if (known && known.fresh) return known.verdict;
						const rendered = ctx.getSectionInfo(el)?.text;
						// No answer from this section (a heading's own title has
						// none): no ink for it, and nothing remembered, so a later
						// section of the same render can still answer.
						if (rendered === undefined) return known ? known.verdict : Promise.resolve(false);
						const markFresh = (entry: { fresh: boolean }) => {
							entry.fresh = true;
							queueMicrotask(() => {
								entry.fresh = false;
							});
						};
						if (known && known.rendered === rendered) {
							markFresh(known);
							return known.verdict;
						}
						const entry = {
							rendered,
							fresh: false,
							verdict: readNoteText(path).then((file) => {
								if (file === null) return false;
								if (file === rendered) return true;
								const norm = (t: string) => t.replace(/\r\n/g, "\n").trimEnd();
								return norm(rendered) === norm(file);
							}),
						};
						markFresh(entry);
						if (container) hoverWholeNote.set(container, entry);
						return entry.verdict;
					},
					false,
					lines
				);
			};
			child.onload = () => {
				// Synchronously when the ink is already in the session, which
				// it is whenever the note is open. An export renders the note
				// and then SERIALIZES it, so ink that arrives on a later tick
				// arrives after the picture was taken - and awaiting a promise
				// that had nothing to do would lose the page its ink for the
				// sake of a microtask.
				if (inlineInk.isLoaded(path)) {
					// Registered even with zero strokes: a note drawn on
					// AFTER its embed rendered still gains ink live.
					attach();
					// The record may predate ink another device synced since;
					// ask the same freshness question a reopened editor asks, and
					// repaint if the sidecar was newer. The picture an export
					// takes is the one painted above. A note an editor pane holds
					// is that pane's to refresh: its poll waits for a quiet pane,
					// and an adoption here could land in the middle of a stroke or
					// a lasso.
					if (!overlayForPath(path)) {
						runDetached(
							inlineInk.ensureLoaded(path).then((changed) => {
								if (!changed) return;
								inkExternallyReloaded(path);
							}),
							"refresh ink for an embed"
						);
					}
					return;
				}
				runDetached(
					inlineInk.ensureLoaded(path).then(attach),
					"render ink into an embed"
				);
			};
			child.onunload = () => {
				childUnloaded = true;
				cancelRetry?.();
			};
			ctx.addChild(child);
		});
	}

	/** The live reload poll: ink synced in from another device appears without a reload. */
	function onloadLiveReload(this: HandwritingPlugin): void {
		// Live reload: ink synced in from another device appears without a
		// restart. One stat per open, quiet editor per check; the store
		// adopts a changed sidecar only when nothing local is unsaved and no
		// gesture is active, and the write-path conflict guard keeps its
		// last word. Dot-folders are invisible to vault events (sidecars
		// are not vault-indexed files), which is why this polls.
		let reloadTickBusy = false;
		// A sidecar belongs to a document, but each live pane owns its repaint.
		// Keep exact bindings so a deferred repaint cannot reach a replacement.
		const pendingPdfRefreshes = new Map<HTMLElement, { id: string; controller: PdfInkController }>();
		const currentPdfPanes = (id: string) => [...this.pdfInk].filter(
			([root]) => root.isConnected && this.pdfIds.get(root) === id
		);
		const refreshPendingPdfPanes = (failed: Map<PdfInkController, "eligibility" | "refresh">) => {
			for (const [root, binding] of pendingPdfRefreshes) {
				const { id, controller } = binding;
				let phase: "eligibility" | "refresh" = "eligibility";
				try {
					if (!root.isConnected || this.pdfInk.get(root) !== controller || this.pdfIds.get(root) !== id) {
						pendingPdfRefreshes.delete(root);
						continue;
					}
					if (failed.has(controller) || !controller.idle) continue;
					phase = "refresh";
					controller.refresh();
					pendingPdfRefreshes.delete(root);
				} catch (err) {
					// Retry on the next visible tick, even without another mtime.
					// A fresh adoption later this tick must not retry the failure.
					failed.set(controller, phase);
					console.error(`[handwriting] live-reload poll failed for PDF ${id}`, err);
				}
			}
		};
		// Idle backoff. This exists to notice another device's write, and every
		// tick that finds nothing still costs a stat per open document -
		// forever, on battery, whether or not a second device exists. Quiet
		// ticks get rarer; anything found puts it straight back to one second.
		let quietTicks = 0;
		let ticks = 0;
		let wasHidden = false;
		this.registerInterval(
			window.setInterval(() => {
				if (reloadTickBusy) return;
				this.pollStats.ticks++;
				// Nobody is watching ink arrive in a hidden window, and the
				// first visible tick catches up on everything missed. Every
				// window holding a pane, not the main one alone (audit 56).
				if (this.reloadPanesHidden(document)) {
					wasHidden = true;
					this.pollStats.hidden++;
					return;
				}
				if (wasHidden) {
					wasHidden = false;
					quietTicks = 0;
				}
				// Display debt is independent of the stat cadence and never resets it.
				const failedPdfRefreshes = new Map<PdfInkController, "eligibility" | "refresh">();
				refreshPendingPdfPanes(failedPdfRefreshes);
				ticks++;
				if (ticks % reloadStride(quietTicks) !== 0) {
					this.pollStats.spaced++;
					return;
				}
				this.pollStats.checks++;
				reloadTickBusy = true;
				runDetached(
					(async () => {
						let changed = false;
						// Open PDFs, on the same tick. Their sidecars live in
						// the same unindexed folder and change for the same
						// reason - another device wrote them - so they need the
						// same poll rather than a second one keeping its own
						// time.
						const pdfIds = new Set([...this.pdfInk.keys()].map(root => this.pdfIds.get(root)));
						for (const id of pdfIds) {
							if (!id) continue;
							try {
								let panes = currentPdfPanes(id);
								if (!panes.length || panes.some(([, controller]) =>
									failedPdfRefreshes.get(controller) === "eligibility" || !controller.idle
								)) continue;
								// Positively observed absence counts here as it does for a
								// note: it goes on to the adoption, which holds and, once
								// the absence persists, tells the user. Stat and read
								// errors stay unchanged.
								const sidecarChanged = await this.store.externallyChanged(id);
								const observation = sidecarChanged
									? "changed"
									: (this.store.externalChangeObservation?.(id) ?? "unchanged");
								if (observation === "unchanged") continue;
								// Stat awaited: panes may have joined, switched or started
								// a gesture. Check every current binding before reloading
								// the record they all share.
								panes = currentPdfPanes(id);
								if (!panes.length || panes.some(([, controller]) =>
									failedPdfRefreshes.get(controller) === "eligibility" || !controller.idle
								)) continue;
								// A stroke completed during stat may have queued a stale
								// snapshot. Preserve the write-path conflict guard until
								// that write lands, then reload on a later poll.
								if (this.store.hasQueuedWrite(id)) continue;
								// A PDF opened while its sidecar was mid-sync read it as
								// damaged and locked the record: no ink on screen, and
								// nothing drawn saved, for as long as the PDF stayed
								// open. Adoption answers a lock with "existing-lock",
								// so a locked record is re-read here instead, the way
								// reopening the PDF re-reads it. A read that is still
								// unsound changes nothing and falls through as before.
								if (this.pdfStore.inkReady?.(id) === false && (await this.pdfStore.reloadExternal?.(id))) {
									changed = true;
									for (const [root, controller] of currentPdfPanes(id)) {
										pendingPdfRefreshes.set(root, { id, controller });
									}
									refreshPendingPdfPanes(failedPdfRefreshes);
									continue;
								}
								// Only a completed preserving adoption may replace an
								// established PDF record. Missing capability, unavailable
								// input, locks, preservation failures and stale qualification
								// all retain the record and baseline for a later poll/save.
								const expectedPanes = panes;
								const adoption = await this.pdfStore.adoptExternal?.(id, () => {
									const current = currentPdfPanes(id);
									if (current.length !== expectedPanes.length) return false;
									if (current.some(([, controller]) => !controller.idle)) return false;
									if (this.store.hasQueuedWrite(id)) return false;
									return expectedPanes.every(([root, controller], i) => {
										const binding = current[i];
										return binding?.[0] === root && binding[1] === controller;
									});
								});
								if (adoption?.outcome !== "adopted") continue;
								if (adoption.changed) {
									changed = true;
									// Loading still awaits file I/O; this bookkeeping does
									// not make shared-cache adoption atomic with gestures.
									// Include current panes and defer any that became busy.
									for (const [root, controller] of currentPdfPanes(id)) {
										pendingPdfRefreshes.set(root, { id, controller });
									}
									refreshPendingPdfPanes(failedPdfRefreshes);
								}
							} catch (err) {
								console.error(`[handwriting] live-reload poll failed for PDF ${id}`, err);
							}
						}
						for (const path of inlineReloadCandidates()) {
							// Per note, because this list is walked in the same
							// order every tick: one note that reliably throws -
							// an unreadable sidecar, a stat that keeps failing -
							// would abort the pass at the same place forever and
							// STARVE every note behind it. Live reload would stop
							// for those notes silently, which reads as ink from
							// another device simply never arriving.
							try {
								const id = inlineInk.pageIdOf(path);
								if (!id) {
									// Loaded before the note had an id; sync has since
									// delivered one, and maybe its first ink.
									if (inlineInk.gainedPageId?.(path) && (await inlineInk.ensureLoaded(path))) {
										inkExternallyReloaded(path);
										notifyInkChanged(path);
										changed = true;
									}
									continue;
								}
								// Inline needs one fact the shared boolean intentionally
								// collapses: positively observed absence starts the existing
								// held-adoption notice. PDF reads it the same way; Slides
								// keeps boolean false for absence, and stat/read errors
								// remain ordinary unchanged.
								const sidecarChanged = await this.store.externallyChanged(id);
								const observation = sidecarChanged
									? "changed"
									: (this.store.externalChangeObservation?.(id) ?? "unchanged");
								if (observation === "unchanged") continue;
								// Stat and preservation both await. Capture the current
								// cohort now and recheck it at the final adoption boundary.
								const panesCurrent = captureInlineReloadAdmission(path);
								if (!panesCurrent) continue;
								// Same gap, the other half: a stroke that
								// FINISHED in it left a queued write carrying a
								// pre-reload snapshot, and reloading refreshes
								// the known mtime so the write-path conflict
								// guard no longer sees a reason to preserve
								// anything. Let the write land; the next poll
								// reloads against a mtime that matches it.
								if (this.store.hasQueuedWrite(id)) continue;
								// PRESERVE BOTH REVISIONS BEFORE ADOPTING ONE.
								// A sync replacement is not necessarily a
								// superset of what this device holds, and the
								// an unpreserved reload moves the save baseline to
								// the incoming file - after which nothing holds
								// the outgoing ink at all. The adopting route
								// writes both as independently recoverable
								// siblings first and only then swaps.
								//
								// Only a completed preserving adoption may replace
								// an established record. Missing capability,
								// unavailable preparation, locks and races all hold
								// the current base for a later poll/save. The method
								// stays optional for reduced test stand-ins; absence
								// is also a hold, never reload authority.
								const adoption = await inlineInk.adoptExternal?.(path, () => panesCurrent() &&
									inlineInk.pageIdOf(path) === id && !this.store.hasQueuedWrite(id));
								if (adoption?.outcome !== "adopted") continue;
								if (adoption.changed) {
									inkExternallyReloaded(path);
									notifyInkChanged(path);
									// The release line owns this line, not the cherry-pick:
									// the quiet-tick backoff below reads it, and dropping it
									// would hold the poll at full stride forever.
									changed = true;
								}
							} catch (err) {
								console.error(`[handwriting] live-reload poll failed for ${path}`, err);
							}
						}
						// A live presentation, on the same tick and for the same
						// reason: its `<pageId>.slides` sidecar sits in the same
						// unindexed folder and another device writes it while the
						// deck is open. Without this leg a deck kept its stale
						// copy for the whole presentation and then overwrote the
						// newer file at teardown. Its own try/catch, for the
						// starvation reason the inline loop states.
						try {
							const slidesId = slidesReloadCandidate();
							if (slidesId && (await this.store.externallyChanged(slidesId))) {
								// Re-asked in the same microtask as the adopt: the
								// answer above is a tick old and a pen can have
								// landed on the deck since.
								if (
									slidesReloadCandidate() === slidesId &&
									!this.store.hasQueuedWrite(slidesId) &&
									(await reloadSlidesExternal(slidesId))
								) {
									changed = true;
								}
							}
						} catch (err) {
							console.error("[handwriting] live-reload poll failed for the presentation", err);
						}
						quietTicks = changed ? 0 : quietTicks + 1;
					})().finally(() => {
						reloadTickBusy = false;
					}),
					"live-reload poll"
				);
			}, 1000)
		);
	}

export function installPluginOnloadReload(proto: HandwritingPlugin): void {
	installMethods(proto, {
		onloadEmbeds,
		onloadLiveReload,
	});
}
