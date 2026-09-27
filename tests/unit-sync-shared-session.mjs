/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// Fresh-session transcript: the system prompt arrives as a leading system message
	// (issue #106). It is prompt state, not history — a fresh session must still take
	// the clean-start path (empty priors) rather than rebuild a session file holding nothing
	// but a system head, which made --resume fail with "No conversation found".
	it("takes the clean-start path when a transcript system message precedes the first user message", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const result = __test.syncSharedSession([
				{ role: "system", content: "You are Claude Code.", timestamp: Date.now() },
				{ role: "user", content: "Hello", timestamp: Date.now() },
			], cwd);

			assert.equal(result.sessionId, null, "a fresh session with only prompt state as priors is a clean start");
			assert.equal(result.preserveSharedSession, undefined);
			assert.equal(__test.getSharedSession(), null, "a clean start must not create a session state");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Mid-conversation tool-loadout updates land in the transcript as system messages. They must not inflate the cursor or be imported as history, or the next turn's
	// reuse check (priors >= cursor) fails and every turn rebuilds the session.
	it("keeps cursor arithmetic consistent when system messages punctuate the history", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
			]);
			seeded.save();
			__test.setSharedSession({ sessionId, cursor: 2, cwd });

			const result = __test.syncSharedSession([
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
				{ role: "system", content: "", toolsAdded: [{ name: "grep", description: "", parameters: {} }], timestamp: Date.now() },
				{ role: "user", content: "Next", timestamp: Date.now() },
			], cwd);

			assert.equal(result.sessionId, sessionId, "2 priors at cursor 2 must resume, not rebuild");
			assert.equal(__test.getSharedSession()?.cursor, 2, "cursor counts non-system messages only");
			const session = openSession({ sessionId, projectPath: cwd });
			assert.deepEqual(
				session.messages.map((m) => m.type),
				["user", "assistant"],
				"the resumed session file must hold the non-system history",
			);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// After an abort the dying CLI records the interrupted turn in the session it was
	// resuming. Once it has answered the interrupt, the next turn resumes that session
	// rather than rebuilding it into a new one — a rebuild re-serializes the history and
	// re-caches the whole conversation. Everything that could make the resume wrong
	// falls back to the rotation the abort set.
	describe("after an abort", () => {
		const now = Date.now();
		const history = [
			{ role: "user", content: "Hi", timestamp: now },
			{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: now },
			{ role: "user", content: "Count to 400.", timestamp: now },
		];
		// What pi appends when the turn is aborted: the cut-off answer and the aborted tool result.
		const abortedEnding = [
			{ role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "bash", arguments: {} }], stopReason: "aborted", timestamp: now },
			{ role: "toolResult", toolCallId: "toolu_1", toolName: "bash", content: [{ type: "text", text: "aborted" }], isError: true, timestamp: now },
		];
		const next = { role: "user", content: "What did I ask?", timestamp: now };

		function withAbortedSession(fn) {
			const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
			const sessionId = randomUUID();
			try {
				// The session as the interrupted CLI left it, holding its own record of the turn.
				const seeded = createSession({ sessionId, projectPath: cwd });
				seeded.importMessages([
					{ role: "user", content: "Hi" },
					{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
					{ role: "user", content: "Count to 400." },
					{ role: "user", content: "[Request interrupted by user]" },
				]);
				seeded.save();
				// What onAbort leaves: the rotation, plus the turn it may lift.
				const marked = { sessionId, cursor: 2, cwd, needsRebuild: true, forceRotate: true };
				__test.setSharedSession(marked);
				const turn = { session: marked, seen: history.length, finished: new Set(), drained: true };
				__test.setInterruptedTurn(turn);
				fn({ cwd, sessionId, marked, turn, recordCount: () => openSession({ sessionId, projectPath: cwd }).messages.length });
			} finally {
				__test.setInterruptedTurn(null);
				deleteSession(sessionId, cwd);
				rmSync(cwd, { recursive: true, force: true });
			}
		}

		it("resumes the interrupted session once its CLI has recorded the turn", () => {
			withAbortedSession(({ cwd, sessionId, recordCount }) => {
				const result = __test.syncSharedSession([...history, ...abortedEnding, next], cwd);

				assert.equal(result.sessionId, sessionId, "must resume the session the CLI recorded the turn in");
				assert.equal(recordCount(), 4, "the session must be resumed as the CLI left it, not rewritten");
				assert.deepEqual(__test.getSharedSession(), { sessionId, cursor: 5, cwd }, "cursor moves past the aborted turn, rotation cleared");
			});
		});

		it("rotates while the CLI has not answered the interrupt", () => {
			withAbortedSession(({ cwd, sessionId, turn }) => {
				turn.drained = false;
				const result = __test.syncSharedSession([...history, ...abortedEnding, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "it may still be writing to that session");
			});
		});

		it("rotates when pi added more than the aborted turn's own ending", () => {
			withAbortedSession(({ cwd, sessionId }) => {
				// A turn on another provider in between: Claude Code never saw it.
				const elsewhere = [
					{ role: "user", content: "Ask another model.", timestamp: now },
					{ role: "assistant", content: [{ type: "text", text: "Sure." }], timestamp: now },
				];
				const result = __test.syncSharedSession([...history, ...abortedEnding, ...elsewhere, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "a resume would lose the turn Claude Code never saw");
			});
		});

		it("rotates when a tool finished before the abort could cut it off", () => {
			withAbortedSession(({ cwd, sessionId }) => {
				// pi ran it to completion, but the CLI never got the result and recorded
				// the call as interrupted.
				const finished = [abortedEnding[0], { ...abortedEnding[1], content: [{ type: "text", text: "wrote notes.md" }], isError: false }];
				const result = __test.syncSharedSession([...history, ...finished, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "a resume would hide a tool call that did its work");
			});
		});

		it("rotates when a tool had already failed before the abort", () => {
			withAbortedSession(({ cwd, sessionId, turn }) => {
				// A parallel sibling that errored on its own while another was still
				// running: its error is real, and the CLI never saw it.
				turn.finished = new Set(["toolu_1"]);
				const result = __test.syncSharedSession([...history, ...abortedEnding, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "a resume would hide the tool's own failure");
			});
		});

		it("rotates when a tool failed for a reason of its own", () => {
			withAbortedSession(({ cwd, sessionId }) => {
				// Still running at the abort, but it ignored the signal and then failed
				// on its own: the error is real, and the CLI never saw it.
				const failed = [abortedEnding[0], { ...abortedEnding[1], content: [{ type: "text", text: "ENOSPC: no space left on device" }] }];
				const result = __test.syncSharedSession([...history, ...failed, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "only an error the abort caused may be skipped");
			});
		});

		// pi's bash reports an abort after the output the command had printed so far.
		it("resumes when bash was cut off mid-output", () => {
			withAbortedSession(({ cwd, sessionId }) => {
				const bash = [abortedEnding[0], { ...abortedEnding[1], content: [{ type: "text", text: "started\n\n\nCommand aborted" }] }];
				const result = __test.syncSharedSession([...history, ...bash, next], cwd);

				assert.equal(result.sessionId, sessionId, "bash's own abort status is the abort's error");
			});
		});

		it("rotates when a tool's own error merely mentions an abort", () => {
			withAbortedSession(({ cwd, sessionId }) => {
				const failed = [abortedEnding[0], { ...abortedEnding[1], content: [{ type: "text", text: "ENOENT: no such file or directory, open '/tmp/abort-notes.txt'" }] }];
				const result = __test.syncSharedSession([...history, ...failed, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "a word in a path is not the abort's error");
			});
		});

		it("rotates when the session was marked again since the abort", () => {
			withAbortedSession(({ cwd, sessionId, marked }) => {
				// Compaction, tree navigation and a missed steer all replace the state.
				__test.setSharedSession({ ...marked, needsRebuild: true });
				const result = __test.syncSharedSession([...history, ...abortedEnding, next], cwd);

				assert.notEqual(result.sessionId, sessionId, "a later rebuild request must win");
			});
		});
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			assert.equal(
				result.sessionId,
				null,
				"a context shorter than the cursor — a subagent, or AskClaude — must start a fresh Claude Code session instead of resuming the parent's",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh session must not replace the parent's when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
