// A stand-in for `pi --mode rpc` in subagent tests. The first argument picks the behavior:
// - echo: answer each prompt with "echo: <message>"
// - confirm: ask the parent to confirm, then answer "confirmed: <answer>"
// - crash: exit with code 3 when prompted
// - hang: wait after a prompt until a steer ("steered: <message>") or an abort
// - notify: send an info and a warning notification, then answer like echo
import { createInterface } from "node:readline";

const mode = process.argv[2];
const history = [];
let pendingConfirm;

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (id, command, data) => write({ id, type: "response", command, success: true, data });

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

function addMessage(message) {
	history.push(message);
	write({ type: "message_end", message });
}

function reply(text, aborted = false) {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "fake-model",
		usage,
		stopReason: aborted ? "aborted" : "stop",
		timestamp: Date.now(),
	};
	write({ type: "message_start", message: { ...message, content: [] } });
	write({ type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
	write({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	addMessage(message);
	write({ type: "agent_settled", aborted });
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	switch (command.type) {
		case "get_state":
			respond(command.id, "get_state", {
				sessionFile: "/fake/session.jsonl",
				model: { provider: "faux", id: "fake-model" },
			});
			return;
		case "get_messages":
			respond(command.id, "get_messages", { messages: history });
			return;
		case "prompt":
			if (mode === "crash") process.exit(3);
			respond(command.id, "prompt", { disposition: "started" });
			addMessage({ role: "user", content: command.message, timestamp: Date.now() });
			if (mode === "notify") {
				write({ type: "extension_ui_request", id: "n-1", method: "notify", message: "TPS 24.8 tok/s", notifyType: "info" });
				write({ type: "extension_ui_request", id: "n-2", method: "notify", message: "careful", notifyType: "warning" });
			}
			if (mode === "echo" || mode === "notify") reply(`echo: ${command.message}`);
			if (mode === "confirm") {
				pendingConfirm = "ui-1";
				write({ type: "extension_ui_request", id: pendingConfirm, method: "confirm", title: "Proceed?", message: "Run it" });
			}
			return;
		case "extension_ui_response":
			if (command.id === pendingConfirm) reply(`confirmed: ${command.confirmed}`);
			return;
		case "steer":
			respond(command.id, "steer", { disposition: "queued" });
			addMessage({ role: "user", content: command.message, timestamp: Date.now() });
			reply(`steered: ${command.message}`);
			return;
		case "abort":
			respond(command.id, "abort");
			reply("stopped", true);
			return;
	}
});
