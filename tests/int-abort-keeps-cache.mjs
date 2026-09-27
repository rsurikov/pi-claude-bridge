#!/usr/bin/env node
// The turn after an abort resumes the interrupted Claude Code session instead of
// rebuilding it, so the conversation stays in the prompt cache.
//
// An abort used to force a rebuild into a fresh session: the dying CLI might still
// be writing to the old one (#86). A rebuild re-serializes pi's history, which no
// longer matches the cached prefix, so the whole conversation was written to the
// cache again — 328k tokens on one Esc in a long session. Once the CLI has
// answered the interrupt it has recorded the turn and writes nothing further into
// the conversation, so the bridge resumes that session where it stands.
//
// Discriminating check: a resumed turn reads at least the prefix the turn before
// the abort read; a rebuilt one reads only the system prompt. Measured on Haiku
// before the change: 6784 read after the abort vs 7814 before it.
//
// Requires: CC logged in (or ANTHROPIC_API_KEY). Uses Haiku, four short turns.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lastAssistant = (end) => end.messages.filter((m) => m.role === "assistant").at(-1);

// Each tool words its abort error its own way, and only a known wording lets the
// turn resume. pi's bash appends its status to the output it had printed so far,
// which the SlowTool fixture never exercises.
const abortedCalls = [
	{ tool: "SlowTool", prompt: "Call SlowTool with seconds=60.", settle: 0 },
	{ tool: "bash", prompt: "Run this exact bash command: echo started; sleep 60", settle: 1500 },
];

for (const { tool, prompt, settle } of abortedCalls) test(`the turn after aborting ${tool} resumes the interrupted session and keeps the cache`, { timeout: 240_000 }, async () => {
	const harness = createRpcHarness({
		name: `abort-keeps-cache-${tool}`,
		args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", BRIDGE_MODEL],
		defaultTimeout: 90_000,
	});
	const turn = async (message) => {
		const end = harness.waitForEvent("agent_end", 90_000);
		await harness.send({ type: "prompt", message });
		return lastAssistant(await end);
	};

	await harness.startAndWait();
	try {
		await turn("Please remember: the word is PERCH. Then write three sentences about rivers. Do not use any tool.");
		const beforeAbort = await turn("Write three sentences about lakes. Do not use any tool.");

		const idle = harness.waitForEvent("agent_end", 90_000);
		await harness.send({ type: "prompt", message: prompt });
		await harness.waitForMatch((msg) => msg.type === "tool_execution_start" && msg.toolName === tool, `${tool} to start`, 90_000);
		// Let the command print something before the abort cuts it off.
		await sleep(settle);
		await harness.send({ type: "abort" });
		await idle;
		// A person types for longer than the CLI takes to answer the interrupt (~40ms).
		await sleep(500);

		const afterAbort = await turn("What word did I ask you to remember? Reply with just the word.");
		const text = afterAbort.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.match(text, /perch/i, "the resumed session must still hold the conversation");

		const syncs = readFileSync(harness.DEBUG_LOG, "utf8").split("\n").filter((l) => l.includes("syncResult:"));
		assert.match(syncs.at(-1), /path=reuse .*post-abort/, `the turn after the abort did not resume the interrupted session:\n${syncs.join("\n")}`);
		assert.ok(afterAbort.usage.cacheRead >= beforeAbort.usage.cacheRead,
			`the conversation fell out of the cache: read ${afterAbort.usage.cacheRead} after the abort vs ${beforeAbort.usage.cacheRead} before it`);
	} finally {
		await harness.stop();
	}
});

// The resume skips pi's record of the aborted turn in favour of the CLI's, which is
// only right for tool calls the abort cut off. A parallel sibling that had already
// failed has a real error the CLI never saw, so that turn must rotate instead.
test("a tool that failed before the abort keeps the rotation", { timeout: 240_000 }, async () => {
	const harness = createRpcHarness({
		name: "abort-after-tool-failed",
		args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", BRIDGE_MODEL],
		defaultTimeout: 90_000,
	});
	const turn = async (message) => {
		const end = harness.waitForEvent("agent_end", 90_000);
		await harness.send({ type: "prompt", message });
		return lastAssistant(await end);
	};

	await harness.startAndWait();
	try {
		await turn("Please remember: the word is PERCH. Reply with just OK. Do not use any tool.");

		const idle = harness.waitForEvent("agent_end", 90_000);
		const failed = harness.waitForMatch((msg) => msg.type === "tool_execution_end" && msg.toolName === "read", "the read call to fail", 90_000);
		await harness.send({
			type: "prompt",
			message: "In one single message, make two tool calls at the same time: read the file /nonexistent/missing.txt, and call SlowTool with seconds=60.",
		});
		const readEnd = await failed;
		assert.equal(readEnd.isError, true, "the read call was meant to fail");
		await harness.send({ type: "abort" });
		await idle;
		await sleep(500);

		const afterAbort = await turn("What word did I ask you to remember? Reply with just the word.");
		const text = afterAbort.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.match(text, /perch/i, "the rebuilt session must still hold the conversation");

		const syncs = readFileSync(harness.DEBUG_LOG, "utf8").split("\n").filter((l) => l.includes("syncResult:"));
		assert.match(syncs.at(-1), /rotated-post-abort/, `the turn after the abort resumed although a tool had already failed:\n${syncs.join("\n")}`);
	} finally {
		await harness.stop();
	}
});
