import * as path from "node:path";
import type { AgentConfig } from "../../agents/agents.ts";
import { resolveSkillsWithFallback, type ResolvedSkill } from "../../agents/skills.ts";
import type { PreflightFailure } from "../../shared/types.ts";
import { resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist.ts";

export interface ResourcePreflightResult {
	resolvedSkills: ResolvedSkill[];
	optionalSkillWarnings: string[];
	/** Resolved names and locations retained by callers that persist launch provenance. */
	resolvedSkillProvenance: Array<{ name: string; path: string; source: string; required: boolean }>;
	failure?: PreflightFailure;
}

/** Pi's documented builtin names, used only when no ExtensionAPI registry exists. */
const DOCUMENTED_BUILTIN_TOOLS = new Set([
	"read", "bash", "edit", "write", "grep", "find", "ls",
]);

function uniqueNames(names: Iterable<string> | undefined): string[] {
	return [...new Set([...(names ?? [])].map((name) => name.trim()).filter(Boolean))];
}

function resourceFailure(agent: AgentConfig, resourceType: PreflightFailure["resourceType"], resources: string[], detail?: string): PreflightFailure {
	const label = resources.length === 1 ? "resource" : "resources";
	const typeLabel = resourceType === "skill" ? "skill" : "tool";
	return {
		resourceType,
		resources,
		message: `Preflight failed for agent '${agent.name}': required ${typeLabel} ${label} unavailable: ${resources.join(", ")}.${detail ? ` ${detail}` : ""}`,
	};
}

/**
 * Capture configured and active Pi tool names. A defined empty array means the
 * registry was available; undefined is reserved for direct callers with no
 * registry metadata.
 */
export function resolvePiToolNames(api: {
	getAllTools?: () => unknown;
	getActiveTools?: () => unknown;
}): string[] | undefined {
	const names = new Set<string>();
	let registryAvailable = false;
	try {
		if (typeof api.getAllTools === "function") {
			registryAvailable = true;
			const tools = api.getAllTools();
			if (Array.isArray(tools)) {
				for (const tool of tools) {
					if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
					const name = (tool as { name?: unknown }).name;
					if (typeof name === "string" && name.trim()) names.add(name.trim());
				}
			}
		}
	} catch {
		// Keep trying getActiveTools; unknown custom requirements still fail closed.
	}
	try {
		if (typeof api.getActiveTools === "function") {
			registryAvailable = true;
			const tools = api.getActiveTools();
			if (Array.isArray(tools)) {
				for (const name of tools) {
					if (typeof name === "string" && name.trim()) names.add(name.trim());
				}
			}
		}
	} catch {
		// Preserve any successfully captured getAllTools metadata.
	}
	return registryAvailable ? [...names] : undefined;
}

function isAllowlisted(agent: AgentConfig, tool: string): boolean {
	// Undefined leaves Pi's default builtin set active. An explicit list,
	// including an empty MCP-only builtin list, is a strict child allowlist.
	return agent.tools === undefined || agent.tools.includes(tool);
}

const READ_ONLY_FORBIDDEN_BUILTINS = ["write", "edit", "bash"] as const;

/** Read-only role metadata must be enforceable before child launch. */
function readOnlyCapabilityFailure(agent: AgentConfig): PreflightFailure | undefined {
	if (agent.acceptanceCapability !== "read-only") return undefined;
	if (agent.tools === undefined) {
		return {
			resourceType: "tool",
			resources: [...READ_ONLY_FORBIDDEN_BUILTINS],
			message: `Preflight failed for agent '${agent.name}': acceptanceCapability 'read-only' requires an explicit tools allowlist; Pi's default tool set includes forbidden mutating builtins: ${READ_ONLY_FORBIDDEN_BUILTINS.join(", ")}.`,
		};
	}
	const forbidden = agent.tools.filter((tool): tool is typeof READ_ONLY_FORBIDDEN_BUILTINS[number] =>
		(READ_ONLY_FORBIDDEN_BUILTINS as readonly string[]).includes(tool),
	);
	if (forbidden.length === 0) return undefined;
	return {
		resourceType: "tool",
		resources: forbidden,
		message: `Preflight failed for agent '${agent.name}': acceptanceCapability 'read-only' forbids mutating builtin tool(s): ${forbidden.join(", ")}. Unrestricted bash is not permitted for read-only roles.`,
	};
}

function requiredToolFailure(agent: AgentConfig, cwd: string, availableToolNames: string[] | undefined): PreflightFailure | undefined {
	const requiredTools = uniqueNames(agent.requiredTools);
	if (requiredTools.length === 0) return undefined;

	const available = availableToolNames === undefined ? undefined : new Set(uniqueNames(availableToolNames));
	const unavailable: string[] = [];
	for (const required of requiredTools) {
		if (required.startsWith("mcp:")) {
			const selection = required.slice(4).trim();
			const permitted = Boolean(selection && agent.mcpDirectTools?.includes(selection));
			const resolved = permitted ? resolveMcpDirectToolNames([selection], cwd) : [];
			if (resolved.length === 0 || (available !== undefined && resolved.some((name) => !available.has(name)))) unavailable.push(required);
			continue;
		}
		if (!isAllowlisted(agent, required)) {
			unavailable.push(required);
			continue;
		}
		if (available !== undefined) {
			if (!available.has(required)) unavailable.push(required);
			continue;
		}
		if (!DOCUMENTED_BUILTIN_TOOLS.has(required)) unavailable.push(required);
	}
	return unavailable.length > 0
		? resourceFailure(agent, "tool", unavailable, "Required tools must be permitted by the role-card tools allowlist and present in Pi's active/configured registry.")
		: undefined;
}

function provenance(skills: ResolvedSkill[], requiredNames: Set<string>): ResourcePreflightResult["resolvedSkillProvenance"] {
	return skills.map((skill) => ({ name: skill.name, path: skill.path, source: skill.source, required: requiredNames.has(skill.name) }));
}

function resolveForAgent(agent: AgentConfig, names: string[], cwd: string, fallbackCwd?: string): { resolved: ResolvedSkill[]; missing: string[] } {
	return resolveSkillsWithFallback(
		names,
		cwd,
		fallbackCwd,
		agent.skillPath,
		agent.filePath ? path.dirname(agent.filePath) : cwd,
	);
}

/**
 * Resolve child resources before a model process starts.
 *
 * requiredSkills and explicit per-run selections are fail-closed. Legacy
 * skills/optionalSkills remain best effort. Explicit [] suppresses only those
 * best-effort lists and can never bypass role-card requirements.
 */
export function preflightSubagentResources(input: {
	agent: AgentConfig;
	cwd: string;
	fallbackCwd?: string;
	availableToolNames?: string[];
	skills?: string[];
	useAgentSkills?: boolean;
}): ResourcePreflightResult {
	const includeLegacySkills = input.useAgentSkills ?? input.skills === undefined;
	const requiredNames = uniqueNames([...(input.agent.requiredSkills ?? []), ...(input.skills ?? [])]);
	const requiredNameSet = new Set(requiredNames);
	const legacyRoleNames = includeLegacySkills ? uniqueNames(input.agent.skills) : [];
	const optionalNames = includeLegacySkills ? uniqueNames(input.agent.optionalSkills) : [];
	const legacyNames = uniqueNames([...legacyRoleNames, ...optionalNames]);

	let required: { resolved: ResolvedSkill[]; missing: string[] };
	try {
		required = resolveForAgent(input.agent, requiredNames, input.cwd, input.fallbackCwd);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			resolvedSkills: [],
			optionalSkillWarnings: [],
			resolvedSkillProvenance: [],
			failure: resourceFailure(input.agent, "skill", requiredNames.length ? requiredNames : ["skill discovery"], detail),
		};
	}
	if (required.missing.length > 0) {
		return {
			resolvedSkills: required.resolved,
			optionalSkillWarnings: [],
			resolvedSkillProvenance: provenance(required.resolved, requiredNameSet),
			failure: resourceFailure(input.agent, "skill", required.missing, `Skills not found: ${required.missing.join(", ")}`),
		};
	}

	const capabilityFailure = readOnlyCapabilityFailure(input.agent);
	if (capabilityFailure) {
		return {
			resolvedSkills: required.resolved,
			optionalSkillWarnings: [],
			resolvedSkillProvenance: provenance(required.resolved, requiredNameSet),
			failure: capabilityFailure,
		};
	}
	const toolFailure = requiredToolFailure(input.agent, input.cwd, input.availableToolNames);
	if (toolFailure) {
		return {
			resolvedSkills: required.resolved,
			optionalSkillWarnings: [],
			resolvedSkillProvenance: provenance(required.resolved, requiredNameSet),
			failure: toolFailure,
		};
	}

	let legacy: { resolved: ResolvedSkill[]; missing: string[] } = { resolved: [], missing: [] };
	if (legacyNames.length > 0) {
		try {
			legacy = resolveForAgent(input.agent, legacyNames, input.cwd, input.fallbackCwd);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return {
				resolvedSkills: required.resolved,
				optionalSkillWarnings: [`Best-effort skill discovery failed: ${detail}`],
				resolvedSkillProvenance: provenance(required.resolved, requiredNameSet),
			};
		}
	}

	const resolvedByName = new Map<string, ResolvedSkill>();
	for (const skill of [...required.resolved, ...legacy.resolved]) {
		if (!resolvedByName.has(skill.name)) resolvedByName.set(skill.name, skill);
	}
	const resolvedSkills = [...resolvedByName.values()];
	const optionalNameSet = new Set(optionalNames);
	const optionalMissing = legacy.missing.filter((name) => optionalNameSet.has(name));
	const legacyMissing = legacy.missing.filter((name) => !optionalNameSet.has(name));
	return {
		resolvedSkills,
		optionalSkillWarnings: [
			...(legacyMissing.length > 0 ? [`Legacy skills not found: ${legacyMissing.join(", ")}`] : []),
			...(optionalMissing.length > 0 ? [`Optional skills not found: ${optionalMissing.join(", ")}`] : []),
		],
		resolvedSkillProvenance: provenance(resolvedSkills, requiredNameSet),
	};
}
