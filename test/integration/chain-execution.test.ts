/**
 * Integration tests for chain execution (sequential and parallel steps).
 *
 * Uses the local createMockPi() harness to simulate subagent processes.
 * Tests the full chain pipeline: template resolution → spawn → output capture
 * → {previous} passing.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgent,
	makeMinimalCtx,
	tryImport,
	events,
} from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";

interface TestSequentialStep {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
	agentContract?: { version: 1 };
	gateOn?: "execution" | "acceptance";
}

interface TestParallelTask {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
	agentContract?: { version: 1 };
	gateOn?: "execution" | "acceptance";
}

type TestChainStep = TestSequentialStep | {
	parallel: TestParallelTask[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
	agentContract?: { version: 1 };
	gateOn?: "execution" | "acceptance";
} | {
	expand: {
		from: { output: string; path: string };
		item?: string;
		key?: string;
		maxItems?: number;
		onEmpty?: "skip" | "fail";
	};
	parallel: TestParallelTask;
	collect: { as: string; outputSchema?: Record<string, unknown> };
	concurrency?: number;
	failFast?: boolean;
	label?: string;
	acceptance?: unknown;
	agentContract?: { version: 1 };
	gateOn?: "execution" | "acceptance";
};

interface ChainResultItem {
	agent: string;
	exitCode: number;
	finalOutput?: string;
	structuredOutput?: unknown;
	task?: string;
	detached?: boolean;
	timedOut?: boolean;
	error?: string;
	attemptedModels?: string[];
	skills?: string[];
	acceptance?: {
		status?: string;
		verifyRuns?: Array<{ status?: string }>;
		childReport?: { commandsRun?: Array<{ result?: string }>; notApplicableEvidence?: string[] };
		runtimeChecks?: Array<{ status?: string; id?: string }>;
		effectiveAcceptance?: { context?: { capability?: string; notApplicableEvidence?: string[] } };
	};
	resourceProvenance?: Array<{ name?: string; path?: string; source?: string; required?: boolean }>;
}

interface ChainExecutionResult {
	isError?: boolean;
	content: Array<{ text: string }>;
	details: {
		results: ChainResultItem[];
		chainAgents?: string[];
		totalSteps?: number;
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		workflowGraph?: {
			nodes: Array<{ kind?: string; agent?: string; flatIndex?: number; outputName?: string; status?: string; error?: string; acceptanceStatus?: string; children?: Array<{ itemKey?: string; label?: string; status?: string; acceptanceStatus?: string }> }>;
		};
		currentStepIndex?: number;
		outputs?: Record<string, { text: string; structured?: unknown }>;
		parallelHandoff?: { version: number; path: string; groupCount: number; childCount: number; cleanupState: string };
	};
}

interface ChainExecutionModule {
	executeChain(params: Record<string, unknown>): Promise<ChainExecutionResult>;
}

interface ChainSerializerModule {
	parseChain(content: string, source: "project", filePath: string): { name: string; steps: TestChainStep[] };
}

const chainMod = await tryImport<ChainExecutionModule>("./src/runs/foreground/chain-execution.ts");
const chainSerializerMod = await tryImport<ChainSerializerModule>("./src/agents/chain-serializer.ts");
const available = !!chainMod;
const executeChain = chainMod?.executeChain;

describe("chain execution — sequential", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		artifactsDir = path.join(tempDir, "artifacts");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function acceptanceReport(overrides: Record<string, unknown> = {}): string {
		return [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
				...overrides,
			}),
			"```",
		].join("\n");
	}

	function writePackageSkill(packageRoot: string, skillName: string): void {
		const skillDir = path.join(packageRoot, "skills", skillName);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
			"utf-8",
		);
	}

	const stanToolNames = [
		"read", "write", "edit", "bash", "grep", "find", "ls",
		"retrieve_memory", "retrieve_project_state_snapshot", "propose_memory", "search_sessions",
	];

	function makeStanV070Agents(): ReturnType<typeof makeAgent>[] {
		const readOnlyTools = ["read", "grep", "find", "ls", "retrieve_memory", "retrieve_project_state_snapshot", "propose_memory", "search_sessions"];
		const mutatingTools = ["read", "write", "edit", "bash", "grep", "find", "ls", "retrieve_memory", "retrieve_project_state_snapshot", "propose_memory", "search_sessions"];
		return [
			makeAgent("stan-architect", {
				tools: readOnlyTools,
				requiredTools: ["read", "grep", "find", "ls", "retrieve_project_state_snapshot", "retrieve_memory"],
				requiredSkills: ["load-project-state", "plan-code-change", "accept-task", "codeguard", "trace-work"],
				acceptanceCapability: "read-only",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: true,
				defaultContext: "fresh",
				maxSubagentDepth: 0,
			}),
			makeAgent("stan-reviewer", {
				tools: readOnlyTools,
				requiredTools: ["read", "grep", "find", "ls", "retrieve_project_state_snapshot", "retrieve_memory"],
				requiredSkills: ["load-project-state", "review-plan", "review-diff-before-final", "codeguard", "codeguard-reviewer", "trace-work"],
				acceptanceCapability: "read-only",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: true,
				defaultContext: "fresh",
				maxSubagentDepth: 0,
			}),
			makeAgent("stan-test-engineer", {
				tools: mutatingTools,
				requiredTools: ["read", "write", "edit", "bash", "grep", "retrieve_project_state_snapshot", "retrieve_memory"],
				requiredSkills: ["load-project-state", "write-gate-tests", "validate-code-change", "accept-task", "trace-work"],
				acceptanceCapability: "mutating",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: true,
				defaultContext: "fork",
				maxSubagentDepth: 0,
			}),
			makeAgent("stan-dev", {
				tools: mutatingTools,
				requiredTools: ["read", "write", "edit", "bash", "grep", "retrieve_project_state_snapshot", "retrieve_memory"],
				requiredSkills: ["load-project-state", "implement-code-change", "validate-code-change", "accept-task", "dependency-change", "codeguard", "trace-work"],
				acceptanceCapability: "mutating",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: true,
				defaultContext: "fork",
				maxSubagentDepth: 0,
			}),
			makeAgent("stan-qa-evaluator", {
				tools: readOnlyTools,
				requiredTools: ["read", "grep", "find", "ls", "retrieve_project_state_snapshot", "retrieve_memory"],
				requiredSkills: ["load-project-state", "evaluate-golden", "accept-task", "codeguard", "trace-work"],
				acceptanceCapability: "read-only",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: true,
				defaultContext: "fresh",
				completionGuard: false,
				maxSubagentDepth: 0,
			}),
		];
	}

	function writeStanSkillFixtures(agents: ReturnType<typeof makeAgent>[]): void {
		const names = new Set(agents.flatMap((agent) => agent.requiredSkills ?? []));
		for (const name of names) {
			const skillDir = path.join(tempDir, ".pi", "skills", name);
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Stan v0.7.0 integration fixture\n---\nfixture\n`, "utf-8");
		}
	}

	function parseStanV070Chain(): { name: string; steps: TestChainStep[] } {
		assert.ok(chainSerializerMod, "chain serializer should be importable");
		const chainPath = fileURLToPath(new URL("../fixtures/stan-v0.7.0/stan-standard-tdd-change.chain.md", import.meta.url));
		return chainSerializerMod.parseChain(fs.readFileSync(chainPath, "utf-8"), "project", chainPath);
	}

	function fencedStanReport(report: Record<string, unknown>, verdict = "PASS"): string {
		return `${verdict}\n\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``;
	}

	function stanReadOnlyReport(evidence: string, verdict = "PASS"): string {
		return fencedStanReport({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence }],
			reviewFindings: [evidence],
			residualRisks: [],
			notApplicableEvidence: ["changed-files", "tests-added"],
		}, verdict);
	}

	it("runs a 2-step chain", async () => {
		mockPi.onCall({ output: "Analysis complete: found 3 issues" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].agent, "analyst");
		assert.equal(result.details.results[1].agent, "reporter");
		assert.deepEqual(result.details.totalCost, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 });
	});

	it("runs a foreground sequential chain without clarify UI when clarify is omitted", async () => {
		mockPi.onCall({ output: "Analysis complete" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];
		let customCalls = 0;
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => {
					customCalls += 1;
					return undefined;
				},
			},
		};

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
				{ ctx, clarify: undefined },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Chain cancelled/);
		assert.equal(result.details.results.length, 2);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(customCalls, 0);
	});

	it("uses clarify UI for a foreground sequential chain when clarify is true", async () => {
		mockPi.onCall({ output: "Analysis complete" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];
		let customCalls = 0;
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => {
					customCalls += 1;
					return {
						confirmed: true,
						templates: ["Clarified analysis", "Report on {previous}"],
						behaviorOverrides: [],
					};
				},
			},
		};

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
				{ ctx, clarify: true },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(customCalls, 1);
		assert.equal(mockPi.callCount(), 2);
		assert.match(readCallArgs(0).at(-1) ?? "", /Clarified analysis/);
	});

	it("preserves completed chain results and marks the timed-out current step", async () => {
		mockPi.onCall({ matchArgIncludes: "Quick first step", output: "first done" });
		mockPi.onCall({ matchArgIncludes: "Slow second step", delay: 10000 });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const start = Date.now();
		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Quick first step" }, { agent: "reporter", task: "Slow second step" }],
				agents,
				{ timeoutMs: 300 },
			),
		);
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.equal(result.isError, true);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0]?.exitCode, 0);
		assert.equal(result.details.results[0]?.finalOutput, "first done");
		assert.equal(result.details.results[1]?.timedOut, true);
		assert.equal(result.details.results[1]?.error, "Subagent timed out after 300ms.");
		assert.match(result.content[0]?.text ?? "", /Subagent timed out after 300ms\./);
	});

	it("passes file-only saved-output references through {previous}", async () => {
		mockPi.onCall({ output: "full chain output\nwith details" });
		const agents = [makeAgent("analyst", { tools: ["read", "grep", "find", "ls"] }), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "analyst", task: "Analyze", output: "analysis.md", outputMode: "file-only" },
					{ agent: "reporter" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const firstTaskArg = readCallArgs(0).at(-1) ?? "";
		assert.match(firstTaskArg, /Return the complete artifact in your final response\./);
		assert.match(firstTaskArg, /runtime will persist it to exactly this path: .*analysis\.md/);
		assert.match(firstTaskArg, /Do not call contact_supervisor merely because no write-capable tool is available\./);
		assert.doesNotMatch(firstTaskArg, /\[Write to:|Write your findings to exactly this path/);
		assert.ok(result.details.results[0]?.savedOutputPath);
		assert.equal(fs.readFileSync(result.details.results[0].savedOutputPath, "utf-8"), "full chain output\nwith details");
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full chain output/);
		const secondTaskArg = readCallArgs(1).at(-1) ?? "";
		assert.match(secondTaskArg, /Output saved to:/);
		assert.match(secondTaskArg, /2 lines/);
		assert.doesNotMatch(secondTaskArg, /full chain output/);
	});

	it("persists explicit checked acceptance and rejects missing evidence", async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const agents = [makeAgent("worker", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", output: "accepted.md", outputMode: "file-only", acceptance: { level: "checked", criteria: ["Patch bug"] } }],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.equal(result.details.results[0]?.acceptance?.status, "checked");
		assert.ok(result.details.results[0]?.acceptance?.childReport);

		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					residualRisks: [],
					noStagedFiles: true,
				}),
				"```",
			].join("\n"),
		});

		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "checked" } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.match(failed.details.results[0]?.error ?? "", /tests-added evidence missing/);
	});

	it("runs explicit verified acceptance commands and does not trust child command claims as verification", async () => {
		const acceptanceReport = [
			"implemented",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "child claimed pass" }],
				validationOutput: ["child output"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: acceptanceReport });
		const agents = [makeAgent("worker", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "verified", verify: [{ id: "runtime-pass", command: "node -e \"process.exit(0)\"" }] } }],
				agents,
			),
		);
		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0]?.acceptance?.status, "verified");
		assert.equal(result.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "passed");

		mockPi.onCall({ output: acceptanceReport });
		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "verified", verify: [{ id: "runtime-fail", command: "node -e \"process.exit(5)\"" }] } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(failed.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "failed");
		assert.match(failed.details.results[0]?.error ?? "", /runtime-fail/);
	});

	it("retries chain steps with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "provider unavailable",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Step 1 recovered" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [
			makeAgent("step1", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			makeAgent("step2"),
		];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("prefers the parent session provider for ambiguous bare chain step models", async () => {
		mockPi.onCall({ output: "Step 1 ran" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [makeAgent("step1", { model: "gpt-5-mini" }), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "github-copilot" },
						modelRegistry: {
							getAvailable: () => [
								{ provider: "openai", id: "gpt-5-mini" },
								{ provider: "github-copilot", id: "gpt-5-mini" },
							],
						},
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.details.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("foreground chains inherit the parent session model when no step or agent model is set", async () => {
		mockPi.onCall({ output: "Step ran" });

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do work" }],
				[makeAgent("worker")],
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "deepseek", id: "deepseek-v4-flash" },
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const args = readCallArgs(0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
		assert.equal(result.details.results[0].model, "deepseek/deepseek-v4-flash");
	});

	it("foreground chains treat the inherit model sentinel as the parent session model", async () => {
		mockPi.onCall({ output: "Step ran" });

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do work", model: "inherit" }],
				[makeAgent("worker")],
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "deepseek", id: "deepseek-v4-flash" },
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const args = readCallArgs(0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
		assert.equal(result.details.results[0].model, "deepseek/deepseek-v4-flash");
	});

	it("suppresses progress for {task} chain templates when the top-level task is review-only", async () => {
		mockPi.onCall({ output: "Review done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer" }],
				agents,
				{ task: "Review-only. Do not edit files. Return findings." },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("foreground chains still resolve defaultProgress inside the chain directory", async () => {
		mockPi.onCall({ output: "Progress done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];
		const chainDir = path.join(tempDir, "chain-progress");
		const runId = "chain-progress-run";

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer", task: "Track chain work" }],
				agents,
				{ chainDir, runId },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.ok(taskArg.includes(`Create and maintain progress at: ${path.join(chainDir, runId, "progress.md")}`), taskArg);
	});

	it("passes {previous} between steps (step 2 receives step 1 output)", async () => {
		mockPi.onCall({ output: "Step 1 unique output: MARKER_ABC_123" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Produce output" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const step2Task = result.details.results[1].task;
		assert.ok(
			step2Task.includes("MARKER_ABC_123"),
			`step 2 task should contain step 1 output via {previous}: ${step2Task.slice(0, 200)}`,
		);
	});

	it("passes named sequential outputs through {outputs.name}", async () => {
		mockPi.onCall({ output: "Context marker: CTX_123" });
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("context"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "context", task: "Gather context", as: "contextOutput" },
					{ agent: "writer", task: "Use {outputs.contextOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.match(readCallArgs(1).at(-1) ?? "", /CTX_123/);
		assert.equal(result.details.workflowGraph?.nodes[0]?.outputName, "contextOutput");
	});

	it("expands structured named output into dynamic parallel children and collects results", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "synthesized" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
						parallel: {
							agent: "reviewer",
							task: "Review {target.path}",
							label: "Review {target.path}",
							outputSchema: { type: "object" },
						},
						collect: { as: "reviews" },
						concurrency: 1,
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readCallArgs(1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readCallArgs(2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readCallArgs(3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = result.details.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.kind, "dynamic-parallel-group");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("persists checked child evidence and pending aggregate review for dynamic fanout", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/a.ts"] }), structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/b.ts"] }), structuredOutput: { ok: "b" } });
		const agents = [makeAgent("scout"), makeAgent("reviewer", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
						collect: { as: "reviews" },
						acceptance: { level: "checked" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.acceptanceStatus, "review-required");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["checked", "checked"]);
		assert.deepEqual(result.details.results.filter((child) => child.agent === "reviewer").map((child) => child.acceptance?.evidenceStatus), ["checked", "checked"]);
	});

	it("applies read-only acceptance roles to dynamic children and their aggregate group", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		const readOnlyReport = acceptanceReport({
			changedFiles: [],
			testsAddedOrUpdated: [],
			commandsRun: [],
			validationOutput: [],
			reviewFindings: ["No blocking findings"],
		});
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "b" } });
		const agents = [makeAgent("scout"), makeAgent("explorer", { acceptanceRole: "read-only" })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "explorer", task: "Explore {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const explorerResults = result.details.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance.level), ["attested", "attested"]);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.acceptanceStatus, "attested");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["attested", "attested"]);
	});

	it("infers foreground dynamic acceptance after materializing item templates", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/a.ts"] }), structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/b.ts"] }), structuredOutput: { ok: "b" } });
		const agents = [makeAgent("scout"), makeAgent("explorer", { acceptanceRole: "read-only" })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "explorer", task: "Patch {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const explorerResults = result.details.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance.level), ["checked", "checked"]);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.acceptanceStatus, "rejected");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["rejected", "rejected"]);
	});

	it("does not expose collected dynamic output when a child fails", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ exitCode: 1, stderr: "review-b failed" });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 3);
		assert.equal(result.details.outputs?.reviews, undefined);
		assert.equal(result.details.results.some((entry) => entry.exitCode === 1), true);
	});

	it("fails dynamic fanout before spawning children for invalid source arrays", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "a" }, { path: "b" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 1 },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /exceeding maxItems 1/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /exceeding maxItems 1/);
	});

	it("marks dynamic file-only validation failures as failed graph groups before spawning children", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputMode: "file-only" },
						collect: { as: "reviews" },
					},
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /outputMode: "file-only"/);
	});

	it("marks empty dynamic fanout skip as a completed graph group", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [] } });
		mockPi.onCall({ output: "used empty reviews" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4, onEmpty: "skip" },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details.outputs?.reviews?.structured, []);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "completed");
		assert.deepEqual(result.details.workflowGraph?.nodes[1]?.children, []);
	});

	it("marks dynamic collect schema failures as failed graph groups", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews", outputSchema: { type: "object" } },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Collected output validation failed/);
		assert.equal(result.details.outputs?.reviews, undefined);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /Collected output validation failed/);
		assert.equal(result.details.workflowGraph?.nodes[1]?.children?.[0]?.status, "completed");
	});

	it("keeps materialized dynamic children in live graph updates for later sequential steps", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ steps: [{ jsonl: [events.assistantMessage("writer started")] }] });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];
		let writerUpdateChildren: Array<{ itemKey?: string; status?: string }> | undefined;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
				{
					onUpdate(update: { details?: ChainExecutionResult["details"] }) {
						if (update.details?.currentStepIndex !== 2) return;
						writerUpdateChildren = update.details.workflowGraph?.nodes[1]?.children;
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(writerUpdateChildren?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("fails duplicate and unknown named outputs before spawning children", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];

		const duplicate = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "A", as: "same" }, { agent: "b", task: "B", as: "same" }],
				agents,
			),
		);
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0]?.text ?? "", /Duplicate chain output name 'same'/);
		assert.equal(mockPi.callCount(), 0);

		const unknown = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.missing}" }],
				agents,
			),
		);
		assert.equal(unknown.isError, true);
		assert.match(unknown.content[0]?.text ?? "", /Unknown chain output reference/);
		assert.equal(mockPi.callCount(), 0);

		const malformed = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.bad-name}" }],
				agents,
			),
		);
		assert.equal(malformed.isError, true);
		assert.match(malformed.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("requires schema-valid structured_output when outputSchema is set", async () => {
		const schema = {
			type: "object",
			required: ["ok"],
			properties: { ok: { type: "boolean" }, note: { type: "string" } },
		};
		mockPi.onCall({ output: "prose", structuredOutput: { ok: true, note: "captured" } });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.results[0]?.structuredOutput, { ok: true, note: "captured" });

		mockPi.reset();
		mockPi.onCall({ structuredOutput: { ok: true, note: "tool-only" } });
		const structuredOnly = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.ok(!structuredOnly.isError);
		assert.deepEqual(structuredOnly.details.results[0]?.structuredOutput, { ok: true, note: "tool-only" });

		mockPi.reset();
		mockPi.onCall({ output: "prose only" });
		const missing = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.equal(missing.isError, true);
		assert.match(missing.details.results[0]?.error ?? "", /Missing structured_output call/);

		mockPi.reset();
		mockPi.onCall({ output: "invalid", structuredOutput: { ok: "yes" } });
		const invalid = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema, phase: "Validate", label: "Structured worker", as: "result" }], agents),
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.details.results[0]?.error ?? "", /Structured output validation failed/);
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.status, "failed");
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.outputName, "result");
		assert.match(invalid.details.workflowGraph?.nodes[0]?.error ?? "", /Structured output validation failed/);
	});

	it("substitutes {task} in templates", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Review {task} carefully" }],
				agents,
				{ task: "the authentication module" },
			),
		);

		assert.ok(!result.isError);
		const workerTask = result.details.results[0].task;
		assert.ok(
			workerTask.includes("the authentication module"),
			`should substitute {task}: ${workerTask.slice(0, 200)}`,
		);
	});

	it("creates and uses chain_dir", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Write to {chain_dir}" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const summary = result.content[0].text;
		assert.ok(summary.includes("✅ Chain completed:"), `missing completion marker: ${summary}`);
		assert.ok(summary.includes("📁 Artifacts:"), `missing artifacts marker: ${summary}`);
	});

	it("stops chain on step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Agent crashed" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do first thing" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail");
		assert.equal(result.details.results.length, 1, "only step1 should have run");
		assert.equal(result.details.results[0].exitCode, 1);
	});

	it("preserves a read-only reviewer's semantic BLOCKED verdict through chain rendering", async () => {
		mockPi.onCall({ output: `BLOCKED

Scope handled: final diff review
Finding: blocker in src/security.ts:42
\`\`\`acceptance-report
{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"Concrete blocker with file and line"}],"reviewFindings":["blocker: src/security.ts:42 - unsafe trust boundary"],"residualRisks":["unsafe trust boundary remains"]}
\`\`\`` });
		const agents = [makeAgent("stan-reviewer", {
			acceptanceRole: "read-only",
			acceptanceCapability: "read-only",
			tools: ["read"],
			completionGuard: false,
		})];

		const result = await executeChain(makeChainParams(
			[{ agent: "stan-reviewer", task: "Review the supplied diff without edits" }],
			agents,
		));

		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0]?.acceptance?.status, "attested");
		assert.match(result.details.results[0]?.finalOutput ?? "", /^BLOCKED\b/);
		assert.match(result.content[0]?.text ?? "", /BLOCKED/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /commands-run evidence missing/);
	});

	it("executes the exact Stan v0.7.0 TDD chain with resource, read-only, and expected-RED evidence", async () => {
		const parsed = parseStanV070Chain();
		assert.equal(parsed.name, "stan-standard-tdd-change");
		assert.equal(parsed.steps.length, 6);
		assert.deepEqual(parsed.steps[2]?.acceptance, {
			level: "checked",
			criteria: [{
				id: "tdd-red-gate",
				must: "The focused regression test demonstrates the current defect before implementation.",
				evidence: ["tests-added", "commands-run"],
				severity: "required",
				allowedCommandOutcomes: ["expected-red", "expected-failure"],
			}],
			evidence: ["tests-added", "commands-run", "residual-risks"],
		});

		const agents = makeStanV070Agents();
		writeStanSkillFixtures(agents);
		mockPi.onCall({ output: stanReadOnlyReport("Plan is scoped and includes ACs, risks, and a TDD gate.") });
		mockPi.onCall({ output: stanReadOnlyReport("Plan review found no blockers.") });
		const gateReport = fencedStanReport({
			criteriaSatisfied: [{ id: "tdd-red-gate", status: "satisfied", evidence: "Focused regression test failed before implementation for the intended assertion." }],
			changedFiles: ["test/regression.test.ts"],
			testsAddedOrUpdated: ["test/regression.test.ts"],
			commandsRun: [{
				command: "npm test -- regression",
				result: "expected-red",
				summary: "Expected assertion failed before production fix.",
				expected: { kind: "expected-red", gateId: "tdd-red-gate", reason: "TDD red gate before implementation" },
			}],
			validationOutput: ["1 focused expected RED"],
			residualRisks: [],
			noStagedFiles: true,
		});
		mockPi.onCall({ jsonl: [...events.completedWrite(path.join(tempDir, "test", "regression.test.ts"), "test mutation evidence\n"), events.assistantMessage(gateReport)] });
		const implementationReport = fencedStanReport({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Implemented only the approved scope." }],
			changedFiles: ["src/fix.ts"],
			testsAddedOrUpdated: ["test/regression.test.ts"],
			commandsRun: [{ command: "npm test -- regression", result: "passed", summary: "Focused test passed after implementation." }],
			validationOutput: ["1 focused test passed"],
			residualRisks: [],
			noStagedFiles: true,
		});
		mockPi.onCall({ jsonl: [...events.completedWrite(path.join(tempDir, "src", "fix.ts"), "implementation evidence\n"), events.assistantMessage(implementationReport)] });
		mockPi.onCall({ output: stanReadOnlyReport("QA consumed supplied validation actions and found no blockers.") });
		mockPi.onCall({ output: stanReadOnlyReport("Final diff review found no blockers and preserved scope.") });

		const result = await executeChain(makeChainParams(parsed.steps, agents, {
			task: "Implement a narrow regression fix using the exact Stan v0.7.0 TDD flow.",
			availableToolNames: stanToolNames,
			chainDir: path.join(tempDir, "chain-run"),
			maxSubagentDepth: 2,
		}));

		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(mockPi.callCount(), 6);
		assert.deepEqual(result.details.results.map((item) => item.acceptance?.status), [
			"attested", "attested", "checked", "checked", "attested", "attested",
		]);
		assert.equal(result.details.results[2]?.acceptance?.childReport?.commandsRun?.[0]?.result, "expected-red");
		assert.equal(result.details.results[2]?.acceptance?.runtimeChecks?.find((check) => check.id === "command:1")?.status, "passed");
		assert.ok(result.details.results.every((item) => (item.resourceProvenance?.length ?? 0) > 0));
		for (const index of [0, 1, 4, 5]) {
			assert.equal(result.details.results[index]?.acceptance?.effectiveAcceptance?.context?.capability, "read-only");
			assert.deepEqual(result.details.results[index]?.acceptance?.childReport?.notApplicableEvidence, ["changed-files", "tests-added"]);
		}
		assert.match(result.content[0]?.text ?? "", /Chain completed/);
	});

	it("preserves BLOCKED from the exact Stan v0.7.0 read-only plan-review prefix", async () => {
		const parsed = parseStanV070Chain();
		const agents = makeStanV070Agents();
		writeStanSkillFixtures(agents);
		mockPi.onCall({ output: stanReadOnlyReport("Plan is scoped and ready for review.") });
		mockPi.onCall({ output: stanReadOnlyReport("Required rollback evidence is missing.", "BLOCKED") });

		const result = await executeChain(makeChainParams(parsed.steps.slice(0, 2), agents, {
			task: "Review a narrow Stan change plan.",
			availableToolNames: stanToolNames,
			chainDir: path.join(tempDir, "blocked-chain-run"),
			maxSubagentDepth: 2,
		}));

		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(mockPi.callCount(), 2);
		assert.equal(result.details.results[1]?.acceptance?.status, "attested");
		assert.match(result.details.results[1]?.finalOutput ?? "", /^BLOCKED\b/);
		assert.match(result.content[0]?.text ?? "", /BLOCKED/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Acceptance rejected|commands-run evidence missing/);
	});

	it("keeps legacy chain agent skills best effort while explicit step skills fail closed", async () => {
		mockPi.onCall({ output: "Legacy skill warning did not block" });
		const legacy = await executeChain(makeChainParams(
			[{ agent: "worker", task: "Inspect" }],
			[makeAgent("worker", { skills: ["missing-legacy-chain-skill"], completionGuard: false })],
		));
		assert.equal(legacy.isError, undefined);
		assert.match((legacy.details.results[0] as ChainResultItem & { skillsWarning?: string }).skillsWarning ?? "", /missing-legacy-chain-skill/);

		const explicit = await executeChain(makeChainParams(
			[{ agent: "worker", task: "Inspect", skill: ["missing-explicit-chain-skill"] }],
			[makeAgent("worker", { completionGuard: false })],
		));
		assert.equal(explicit.isError, true);
		assert.match(explicit.details.results[0]?.error ?? "", /missing-explicit-chain-skill/);
		assert.equal(mockPi.callCount(), 1, "explicit missing skill must fail before a second model launch");
	});

	it("agent contract v1 chain defaults to execution gating after acceptance rejection", async () => {
		mockPi.onCall({ output: "Step 1 done\n```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"not-satisfied\",\"evidence\":\"no proof\"}]}\n```" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [makeAgent("step1", { completionGuard: false }), makeAgent("step2", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "step1", task: "First", acceptance: { level: "checked", criteria: ["Return required proof"] } },
					{ agent: "step2", task: "Second receives {previous}" },
				],
				agents,
				{ task: "Original", agentContract: { version: 1 } },
			),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(result.details.results[0]?.exitCode, 0);
		assert.match(result.details.results[1]?.finalOutput ?? "", /Step 2 ran/);
	});

	it("agent contract v1 chain can gate progression on acceptance", async () => {
		mockPi.onCall({ output: "Step 1 done\n```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"not-satisfied\",\"evidence\":\"no proof\"}]}\n```" });
		const agents = [makeAgent("step1", { completionGuard: false }), makeAgent("step2", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "step1", task: "First", acceptance: { level: "checked", criteria: ["Return required proof"] }, gateOn: "acceptance" },
					{ agent: "step2", task: "Should not run" },
				],
				agents,
				{ task: "Original", agentContract: { version: 1 } },
			),
		);

		assert.equal(result.isError, true);
		assert.equal(result.details.results.length, 1);
		assert.equal(result.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(mockPi.callCount(), 1);
	});

	it("runs a 3-step chain end-to-end", async () => {
		mockPi.onCall({ output: "Step output" });
		const agents = [makeAgent("scout"), makeAgent("planner"), makeAgent("executor")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Survey the codebase" },
					{ agent: "planner" },
					{ agent: "executor" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
	});

	it("runs a 40-step alternating worker and reviewer chain", async () => {
		const chainLength = 40;
		for (let i = 0; i < chainLength; i++) {
			mockPi.onCall({ output: `step-${i}-output` });
		}
		const chain = Array.from({ length: chainLength }, (_, i): TestSequentialStep => ({
			agent: i % 2 === 0 ? "worker" : "reviewer",
			...(i === 0 ? { task: "Start long worker/reviewer chain" } : {}),
		}));
		const agents = [makeAgent("worker"), makeAgent("reviewer")];

		const result = await executeChain(makeChainParams(chain, agents));

		assert.ok(!result.isError, `long chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), chainLength);
		assert.equal(result.details.results.length, chainLength);
		assert.equal(result.details.totalSteps, chainLength);
		assert.equal(result.details.chainAgents?.length, chainLength);
		assert.equal(result.details.workflowGraph?.nodes.length, chainLength);
		assert.equal(result.details.workflowGraph?.nodes.at(-1)?.agent, "reviewer");
		assert.equal(result.details.workflowGraph?.nodes.at(-1)?.flatIndex, chainLength - 1);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
		assert.deepEqual(
			result.details.results.map((r) => r.agent),
			chain.map((step) => step.agent),
		);

		const finalTaskArg = readCallArgs(chainLength - 1).at(-1) ?? "";
		assert.match(finalTaskArg, /step-38-output/);
		assert.doesNotMatch(finalTaskArg, /step-37-output/);
		assert.match(result.content[0]?.text ?? "", /40 steps/);
	});

	it("returns error for unknown agent in chain", async () => {
		const agents = [makeAgent("scout")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "scout", task: "Start" }, { agent: "nonexistent" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Unknown agent"));
	});

	it("resolves relative step cwd values against the chain cwd for skills", async () => {
		mockPi.onCall({ output: "ok" });
		const chainCwd = path.join(tempDir, "worktree");
		const stepPackageDir = path.join(chainCwd, "packages", "app");
		writePackageSkill(stepPackageDir, "chain-step-skill");
		const agents = [makeAgent("analyst", { skills: ["chain-step-skill"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze", cwd: "packages/app" }],
				agents,
				{ cwd: chainCwd },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0]?.skills, ["chain-step-skill"]);
	});

	it("tracks chain metadata (chainAgents, totalSteps)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "Start" }, { agent: "b" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.chainAgents, ["a", "b"]);
		assert.equal(result.details.totalSteps, 2);
	});

	it("uses custom chainDir when provided", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];
		const customChainDir = path.join(tempDir, "my-chain");

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Use {chain_dir}" }],
				agents,
				{ chainDir: customChainDir },
			),
		);

		assert.ok(!result.isError);
		assert.ok(fs.existsSync(customChainDir), "custom chainDir should exist");
	});

	it("tightens child recursion depth per agent without relaxing the inherited chain max", async () => {
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		const originalMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		try {
			mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
			const agents = [makeAgent("worker", { maxSubagentDepth: 1 })];

			const result = await executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Inspect env" }],
					agents,
					{ maxSubagentDepth: 3 },
				),
			);

			assert.ok(!result.isError);
			assert.deepEqual(JSON.parse(result.details.results[0].finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
			if (originalMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = originalMaxDepth;
		}
	});
});

describe("chain execution — parallel steps", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(tempDir, "artifacts"),
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function git(args: string[]): string {
		const result = spawnSync("git", args, { cwd: tempDir, encoding: "utf-8" });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		return result.stdout.trim();
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function readCallArgsMatching(text: string): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		for (const callFile of callFiles) {
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			if (args.join("\n").includes(text)) return args;
		}
		assert.fail(`expected recorded call containing ${text}`);
	}

	it("runs parallel tasks within a chain step", async () => {
		mockPi.onCall({ output: "Parallel task done" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review auth module" },
							{ agent: "reviewer-b", task: "Review data layer" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
	});

	it("aggregates worktree handoffs across foreground chain groups", { skip: process.platform === "win32" ? "worktree paths differ on Windows" : undefined }, async () => {
		git(["init"]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf-8");
		git(["add", "tracked.txt"]);
		git(["commit", "-m", "initial"]);
		mockPi.onCall({ output: "Parallel task done" });
		const runId = "foreground-chain-handoff";
		const artifactsDir = path.join(tempDir, "artifacts");
		const result = await executeChain(
			makeChainParams(
				[{ parallel: [{ agent: "reviewer-a", task: "Review in isolation" }], worktree: true }],
				[makeAgent("reviewer-a")],
				{ runId, artifactsDir },
			),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.parallelHandoff?.version, 1);
		assert.equal(result.details.parallelHandoff?.childCount, 1);
		assert.equal(result.details.parallelHandoff?.cleanupState, "complete");
		const handoff = JSON.parse(fs.readFileSync(result.details.parallelHandoff!.path, "utf-8")) as {
			groups: Array<{ stepIndex: number; children: Array<{ agent: string; patch: { path: string } }>; cleanup: { state: string } }>;
		};
		assert.equal(handoff.groups[0]!.stepIndex, 0);
		assert.equal(handoff.groups[0]!.children[0]!.agent, "reviewer-a");
		assert.equal(handoff.groups[0]!.cleanup.state, "complete");
		assert.equal(fs.existsSync(handoff.groups[0]!.children[0]!.patch.path), true);
		assert.match(handoff.groups[0]!.children[0]!.patch.path, /worktree-diffs\/foreground-chain-handoff\/step-0\//);
	});

	it("aggregates parallel outputs for next sequential step", async () => {
		mockPi.onCall({ output: "Review findings here" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review security" },
							{ agent: "reviewer-b", task: "Review performance" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		const synthTask = result.details.results[2].task;
		assert.ok(
			synthTask.includes("=== Parallel Task 1 (reviewer-a) ==="),
			"synthesizer should include reviewer-a output block",
		);
		assert.ok(
			synthTask.includes("=== Parallel Task 2 (reviewer-b) ==="),
			"synthesizer should include reviewer-b output block",
		);
	});

	it("passes completed parallel task outputs to later {outputs.name} references", async () => {
		mockPi.onCall({ matchArgIncludes: "Alpha", output: "Alpha named output" });
		mockPi.onCall({ matchArgIncludes: "Beta", output: "Beta named output" });
		mockPi.onCall({ output: "Final" });
		const agents = [makeAgent("alpha"), makeAgent("beta"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "alpha", task: "Alpha", as: "alphaOutput" },
							{ agent: "beta", task: "Beta", as: "betaOutput" },
						],
					},
					{ agent: "writer", task: "Use {outputs.alphaOutput} and {outputs.betaOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		const finalTask = readCallArgs(2).at(-1) ?? "";
		assert.match(finalTask, /Alpha named output/);
		assert.match(finalTask, /Beta named output/);
	});

	it("funnels an initial parallel step through one agent, then fans the funnel output back out", async () => {
		mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A findings" });
		mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B findings" });
		mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Funnel synthesis" });
		mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Reviewer A done" });
		mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Reviewer B done" });
		const agents = [makeAgent("scout-a"), makeAgent("scout-b"), makeAgent("synthesizer"), makeAgent("review-a"), makeAgent("review-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "scout-a", task: "Scout API" },
							{ agent: "scout-b", task: "Scout UI" },
						],
					},
					{ agent: "synthesizer", task: "Synthesize:\n{previous}" },
					{
						parallel: [
							{ agent: "review-a", task: "Review funnel A:\n{previous}" },
							{ agent: "review-b", task: "Review funnel B:\n{previous}" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results.map((entry) => entry.agent), ["scout-a", "scout-b", "synthesizer", "review-a", "review-b"]);
		assert.equal(result.details.totalSteps, 3);
		const funnelTask = readCallArgsMatching("Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B findings/);
		const fanoutTaskA = readCallArgsMatching("Review funnel A:").at(-1) ?? "";
		const fanoutTaskB = readCallArgsMatching("Review funnel B:").at(-1) ?? "";
		assert.match(fanoutTaskA, /Review funnel A:\nFunnel synthesis/);
		assert.match(fanoutTaskB, /Review funnel B:\nFunnel synthesis/);
		assert.equal(result.details.workflowGraph?.nodes[0]?.kind, "parallel-group");
		assert.equal(result.details.workflowGraph?.nodes[1]?.kind, "step");
		assert.equal(result.details.workflowGraph?.nodes[2]?.kind, "parallel-group");
	});

	it("aggregates file-only parallel outputs as file references for the next step", async () => {
		mockPi.onCall({ output: "full parallel chain output\nwith details" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review A", output: "a.md", outputMode: "file-only" },
							{ agent: "reviewer-b", task: "Review B", output: "b.md", outputMode: "file-only" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full parallel chain output/);
		assert.doesNotMatch(result.details.results[1]?.finalOutput ?? "", /full parallel chain output/);
		const synthTaskArg = readCallArgs(2).at(-1) ?? "";
		assert.match(synthTaskArg, /Output saved to:/);
		assert.match(synthTaskArg, /2 lines/);
		assert.doesNotMatch(synthTaskArg, /full parallel chain output/);
	});

	it("rejects chain parallel file-only output without spawning siblings", async () => {
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[{
					parallel: [
						{ agent: "reviewer-a", task: "Review A", outputMode: "file-only" },
						{ agent: "reviewer-b", task: "Review B", output: "b.md" },
					],
				}],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("detaches parallel chain children cleanly on intercom handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 25, jsonl: [events.assistantMessage("after handoff")] },
			],
		});
		mockPi.onCall({ delay: 150, output: "Other task done" });
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Send handoff" },
							{ agent: "b", task: "Keep working" },
						],
					},
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }> } }) {
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-parallel-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.match(result.content[0]?.text ?? "", /do not resume or launch a replacement/);
		assert.equal(detachEmitted, true);
		assert.equal(result.details.results.some((entry) => entry.detached === true && entry.exitCode === -2), true);
	});

	it("stops a sequential chain when a child detaches for intercom coordination", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b"),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "a", task: "Ask supervisor" },
					{ agent: "b", task: "Must not run yet" },
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }> } }) {
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-sequential-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.match(result.content[0]?.text ?? "", /do not resume or launch a replacement/);
		assert.equal(detachEmitted, true);
		assert.equal(mockPi.callCount(), 1);
	});

	it("fails chain on parallel step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Parallel task failed" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail when parallel step fails");
	});

	it("rejects worktree parallel steps that set a different task cwd", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];
		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B", cwd: path.join(tempDir, "other") },
						],
						worktree: true,
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should reject conflicting task cwd under worktree");
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(b\) sets cwd/i);
	});

	it("sequential → parallel → sequential (mixed chain)", async () => {
		mockPi.onCall({ output: "Step complete" });
		const agents = [makeAgent("scout"), makeAgent("rev-a"), makeAgent("rev-b"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Initial scan" },
					{
						parallel: [
							{ agent: "rev-a", task: "Deep review A" },
							{ agent: "rev-b", task: "Deep review B" },
						],
					},
					{ agent: "writer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 4);
		assert.equal(result.details.totalSteps, 3);
	});
});
