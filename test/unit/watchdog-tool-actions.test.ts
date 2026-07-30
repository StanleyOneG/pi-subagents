import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import { handleWatchdogToolAction } from "../../src/watchdog/tool-actions.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

interface TestModel {
	provider: string;
	id: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

function createCtx(current: { provider: string; id: string }, availableModels?: TestModel[]) {
	const models = availableModels ?? [
		{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
		{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true },
	];
	return {
		cwd: tempProject,
		model: current,
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: { provider: string; id: string }) => Boolean(model),
		},
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	} as never;
}

function text(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((entry) => entry.text ?? "").join("\n");
}

describe("watchdog tool actions", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-tool-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-tool-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("configures the recommended model for the current session without writing settings", () => {
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });
		const result = handleWatchdogToolAction("watchdog.configure", { model: "recommended" }, createCtx({ provider: "openai-codex", id: "gpt-5.5" }), runtime);

		assert.equal(result.isError, undefined);
		assert.match(text(result), /session model configured: anthropic\/claude-opus-4-8:high/);
		assert.equal(fs.existsSync(path.join(tempHome, ".pi", "agent", "settings.json")), false);
		assert.equal(runtime.getSnapshot(tempProject).config.main.model, "anthropic/claude-opus-4-8");
		assert.equal(runtime.getSnapshot(tempProject).config.main.thinking, "high");
	});

	it("preserves omitted session model fields when configuring thinking", () => {
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });
		const ctx = createCtx({ provider: "openai-codex", id: "gpt-5.5" });

		handleWatchdogToolAction("watchdog.configure", { model: "recommended" }, ctx, runtime);
		const result = handleWatchdogToolAction("watchdog.configure", { thinking: "low" }, ctx, runtime);

		assert.equal(result.isError, undefined);
		assert.equal(runtime.getSnapshot(tempProject).config.main.model, "anthropic/claude-opus-4-8");
		assert.equal(runtime.getSnapshot(tempProject).config.main.thinking, "low");
	});

	it("persists the recommended model when user scope is explicit", () => {
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });
		const result = handleWatchdogToolAction("watchdog.configure", { scope: "user", model: "recommended" }, createCtx({ provider: "anthropic", id: "claude-opus-4-8" }), runtime);

		assert.equal(result.isError, undefined);
		const settings = JSON.parse(fs.readFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), "utf-8"));
		assert.equal(settings.subagents.watchdog.main.model, "openai-codex/gpt-5.5");
		assert.equal(settings.subagents.watchdog.main.thinking, "high");
	});

	it("accepts explicit max configuration only for metadata-advertised models", () => {
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });
		const legacy = { provider: "test", id: "legacy", reasoning: true };
		const rejected = handleWatchdogToolAction(
			"watchdog.configure",
			{ model: "test/legacy", thinking: "max" },
			createCtx({ provider: "test", id: "legacy" }, [legacy]),
			runtime,
		);
		assert.equal(rejected.isError, true);
		assert.match(text(rejected), /thinkingLevelMap\.max/);

		const supported = { provider: "test", id: "metadata-max", reasoning: true, thinkingLevelMap: { max: "max" } };
		const accepted = handleWatchdogToolAction(
			"watchdog.configure",
			{ model: "test/metadata-max", thinking: "max" },
			createCtx({ provider: "test", id: "metadata-max" }, [supported]),
			runtime,
		);
		assert.equal(accepted.isError, undefined);
		assert.equal(runtime.getSnapshot(tempProject).config.main.thinking, "max");
	});

	it("rejects clearing a session override when it would reveal unsupported persisted max", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: { watchdog: { main: { model: "test/legacy", thinking: "max" } } },
		}), "utf-8");
		const supported = { provider: "test", id: "metadata-max", reasoning: true, thinkingLevelMap: { max: "max" } };
		const legacy = { provider: "test", id: "legacy", reasoning: true };
		const ctx = createCtx({ provider: "test", id: "metadata-max" }, [supported, legacy]);
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });

		const override = handleWatchdogToolAction("watchdog.configure", { model: "test/metadata-max", thinking: "low" }, ctx, runtime);
		assert.equal(override.isError, undefined);
		const rejected = handleWatchdogToolAction("watchdog.configure", { model: "inherit" }, ctx, runtime);
		assert.equal(rejected.isError, true);
		assert.match(text(rejected), /thinkingLevelMap\.max/);
		assert.equal(runtime.getSnapshot(tempProject).config.main.model, "test/metadata-max");
		assert.equal(runtime.getSnapshot(tempProject).config.main.thinking, "low");
	});

	it("rejects model changes that would leave saved max attached to an unsupported model", () => {
		const supported = { provider: "test", id: "metadata-max", reasoning: true, thinkingLevelMap: { max: "max" } };
		const legacy = { provider: "test", id: "legacy", reasoning: true };
		const ctx = createCtx({ provider: "test", id: "metadata-max" }, [supported, legacy]);
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });

		const initial = handleWatchdogToolAction("watchdog.configure", { scope: "user", model: "test/metadata-max", thinking: "max" }, ctx, runtime);
		assert.equal(initial.isError, undefined);
		const rejected = handleWatchdogToolAction("watchdog.configure", { scope: "user", model: "test/legacy" }, ctx, runtime);
		assert.equal(rejected.isError, true);
		assert.match(text(rejected), /thinkingLevelMap\.max/);
		const settings = JSON.parse(fs.readFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), "utf-8"));
		assert.equal(settings.subagents.watchdog.main.model, "test/metadata-max");
		assert.equal(settings.subagents.watchdog.main.thinking, "max");

		const unresolvedChildren = handleWatchdogToolAction("watchdog.configure", { scope: "user", target: "children", thinking: "max" }, ctx, runtime);
		assert.equal(unresolvedChildren.isError, true);
		assert.match(text(unresolvedChildren), /explicit max-capable model/);
	});
});
