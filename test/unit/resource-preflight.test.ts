import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { preflightSubagentResources, resolvePiToolNames } from "../../src/runs/shared/resource-preflight.ts";

const dirs: string[] = [];

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Worker",
		systemPrompt: "Do work",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

function writeSkill(root: string, name: string): void {
	const skillDir = path.join(root, ".pi", "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\nTest`, "utf-8");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resource preflight contracts", () => {
	it("captures configured and active Pi tool names while preserving no-registry fallback", () => {
		assert.deepEqual(resolvePiToolNames({ getAllTools: () => [{ name: "web_search" }], getActiveTools: () => ["agent_browser"] }), ["web_search", "agent_browser"]);
		assert.deepEqual(resolvePiToolNames({ getAllTools: () => [], getActiveTools: () => [] }), []);
		assert.equal(resolvePiToolNames({}), undefined);
	});

	it("keeps legacy skills best-effort while required and explicit selections are fail-closed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-preflight-"));
		dirs.push(root);
		writeSkill(root, "legacy-ok");

		const legacy = preflightSubagentResources({ agent: agent({ skills: ["legacy-ok", "legacy-missing"] }), cwd: root });
		assert.equal(legacy.failure, undefined);
		assert.deepEqual(legacy.resolvedSkills.map((skill) => skill.name), ["legacy-ok"]);
		assert.deepEqual(legacy.optionalSkillWarnings, ["Legacy skills not found: legacy-missing"]);

		const required = preflightSubagentResources({ agent: agent({ requiredSkills: ["required-missing"], skills: ["legacy-ok"] }), cwd: root, skills: [] });
		assert.equal(required.failure?.resourceType, "skill");
		assert.deepEqual(required.failure?.resources, ["required-missing"], "skill:false must not bypass role contracts");

		const explicit = preflightSubagentResources({ agent: agent(), cwd: root, skills: ["explicit-missing"], useAgentSkills: false });
		assert.equal(explicit.failure?.resourceType, "skill");
		assert.deepEqual(explicit.failure?.resources, ["explicit-missing"]);
	});

	it("uses the Pi registry for custom required tools while retaining documented builtin fallback", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-preflight-tools-"));
		dirs.push(root);
		const customTool = "retrieve_project_state_snapshot";
		const role = agent({ tools: [customTool], requiredTools: [customTool] });

		assert.equal(preflightSubagentResources({ agent: agent({ tools: ["bash"], requiredTools: ["bash"] }), cwd: root }).failure, undefined);
		assert.equal(preflightSubagentResources({ agent: role, cwd: root, availableToolNames: [customTool] }).failure, undefined, "registered and allowlisted custom tools pass");
		assert.equal(preflightSubagentResources({ agent: role, cwd: root, availableToolNames: [] }).failure?.resourceType, "tool", "a configured registry missing the custom tool fails closed");
		assert.equal(preflightSubagentResources({ agent: agent({ tools: ["invented-tool"], requiredTools: ["invented-tool"] }), cwd: root, availableToolNames: [customTool] }).failure?.resourceType, "tool", "fake names cannot be authorized by frontmatter alone");
		assert.equal(preflightSubagentResources({ agent: agent({ tools: ["web_search"], requiredTools: ["web_search"] }), cwd: root, availableToolNames: ["web_search"] }).failure, undefined);
		assert.equal(preflightSubagentResources({ agent: agent({ tools: ["read"], requiredTools: [customTool] }), cwd: root, availableToolNames: [customTool] }).failure?.resourceType, "tool", "registry membership does not bypass an agent tools allowlist");
	});

	it("rejects read-only roles with mutating builtins before launch while permitting registered non-file tools", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-readonly-preflight-"));
		dirs.push(root);
		for (const tools of [undefined, ["read", "write"], ["read", "edit"], ["read", "bash"]]) {
			const failure = preflightSubagentResources({
				agent: agent({ name: "reviewer", acceptanceCapability: "read-only", ...(tools ? { tools } : {}) }),
				cwd: root,
			});
			assert.equal(failure.failure?.resourceType, "tool");
			assert.match(failure.failure?.message ?? "", /acceptanceCapability 'read-only'/);
		}
		const custom = preflightSubagentResources({
			agent: agent({ name: "browser-reviewer", acceptanceCapability: "read-only", tools: ["read", "agent_browser"] }),
			cwd: root,
			availableToolNames: ["read", "agent_browser"],
		});
		assert.equal(custom.failure, undefined);
	});
});
