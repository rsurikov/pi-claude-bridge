#!/usr/bin/env node
// pi must get a turn back as soon as its outcome is known, not when Claude Code
// exits.
//
// pi waits on the provider stream: the UI shows "Working" and an Esc is not
// acknowledged until the stream ends. The bridge used to end it only after the
// SDK consumer unwound, and the SDK's teardown waits for the CLI to exit
// (Query.cleanup races waitForExit against 2s; the CLI outlasts that on stdin EOF).
// So every finished answer sat on "Working" for ~2.1s, and every Esc took ~2s to
// register — which reads as "press Esc twice". pi's own providers end their
// stream on the terminal event and tear the transport down in the background.
//
// Measured on Agent SDK 0.3.280 before the fix: 2.0–2.2s for both. The bounds
// below leave room for a slow machine while staying well under that.
//
// Requires: CC logged in (or ANTHROPIC_API_KEY). Uses Haiku, two short turns.

import { test } from "node:test";
import assert from "node:assert";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const BOUND_MS = 1000;

const isTextDelta = (msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta";

test("a finished answer and an abort both hand the turn back at once", { timeout: 180_000 }, async () => {
	const harness = createRpcHarness({
		name: "turn-end-latency",
		args: ["--model", BRIDGE_MODEL],
		defaultTimeout: 60_000,
	});

	await harness.startAndWait();
	try {
		// Finished answer: from its last streamed text to pi going idle.
		let lastText = 0;
		const stopTracking = harness.addListener((msg) => { if (isTextDelta(msg)) lastText = Date.now(); });
		const answer = await harness.promptAndWait("Reply with exactly: READY. Do not use any tool.");
		const idleAfterAnswer = Date.now() - lastText;
		stopTracking();
		assert.match(answer, /READY/i, "the answer itself should have arrived");
		assert.ok(idleAfterAnswer < BOUND_MS, `pi went idle ${idleAfterAnswer}ms after the answer finished streaming`);

		// Abort mid-answer: from the abort to pi going idle.
		const idle = harness.waitForEvent("agent_end", 60_000);
		await harness.send({ type: "prompt", message: "Write the numbers from 1 to 400, one per line, and nothing else. Do not use any tool." });
		await harness.waitForMatch(isTextDelta, "the answer to start streaming", 60_000);
		const abortedAt = Date.now();
		await harness.send({ type: "abort" });
		await idle;
		const idleAfterAbort = Date.now() - abortedAt;
		assert.ok(idleAfterAbort < BOUND_MS, `pi went idle ${idleAfterAbort}ms after the abort`);
	} finally {
		await harness.stop();
	}
});
