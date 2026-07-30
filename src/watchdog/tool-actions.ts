import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";
import type { Details } from "../shared/types.ts";
import { buildWatchdogStatus } from "./register-main.ts";
import type { MainWatchdogRuntime } from "./runtime.ts";
import { assertWatchdogConfigurationSupported, assertWatchdogResolvedConfigurationSupported, parseWatchdogThinkingInput, recommendStrongWatchdogModel, resolveWatchdogModelInput } from "./model-selection.ts";
import { readWatchdogPersistentTargetState, resolveWatchdogConfig, writeWatchdogModelSettings, type WatchdogModelSettingsTarget, type WatchdogSettingsWriteScope } from "./settings.ts";

interface WatchdogToolParams {
	action?: string;
	scope?: string;
	target?: string;
	agent?: string;
	model?: string;
	thinking?: string | false;
	cwd?: string;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseScope(raw: string | undefined): "session" | WatchdogSettingsWriteScope {
	if (raw === undefined || raw === "session") return "session";
	if (raw === "user" || raw === "project") return raw;
	throw new Error("watchdog.configure scope must be 'session', 'user', or 'project'.");
}

function parseTarget(params: WatchdogToolParams): WatchdogModelSettingsTarget {
	const target = params.target ?? "main";
	if (target === "main") return { kind: "main" };
	if (target === "children") return { kind: "children" };
	if (target === "child") {
		if (!params.agent?.trim()) throw new Error("watchdog.configure target='child' requires agent.");
		return { kind: "child", agent: params.agent.trim() };
	}
	throw new Error("watchdog.configure target must be 'main', 'children', or 'child'.");
}

function parseThinking(raw: string | false | undefined): ThinkingLevel | false | null | undefined {
	if (raw === undefined) return undefined;
	if (raw === "inherit") return null;
	return parseWatchdogThinkingInput(raw, "watchdog.configure thinking") ?? undefined;
}

interface WatchdogTargetState {
	model?: string;
	thinking?: ThinkingLevel | false;
	inheritedModel?: string;
	inheritedThinking?: ThinkingLevel | false;
	allowCurrentModel: boolean;
}

interface WatchdogModelPatch {
	model?: string | null;
	thinking?: ThinkingLevel | false | null;
}

function configuredTargetState(
	runtime: MainWatchdogRuntime | undefined,
	cwd: string,
	target: WatchdogModelSettingsTarget,
	scope: "session" | WatchdogSettingsWriteScope,
): WatchdogTargetState {
	if (scope !== "session") {
		return { ...readWatchdogPersistentTargetState({ scope, cwd, target }), allowCurrentModel: false };
	}
	const config = runtime?.getSnapshot(cwd).config;
	if (!config) throw new Error("Session-scoped watchdog.configure requires an active watchdog runtime.");
	if (target.kind === "main") {
		const persistent = resolveWatchdogConfig(cwd);
		if (!persistent.ok) throw new Error(persistent.errors.map((error) => error.message).join("\n"));
		return {
			model: config.main.model,
			thinking: config.main.thinking as ThinkingLevel | false | undefined,
			inheritedModel: persistent.config.main.model,
			inheritedThinking: persistent.config.main.thinking as ThinkingLevel | false | undefined,
			allowCurrentModel: true,
		};
	}
	if (target.kind === "children") return { model: config.children.model, thinking: config.children.thinking as ThinkingLevel | false | undefined, allowCurrentModel: false };
	const override = config.children.overrides[target.agent];
	return {
		model: override?.model ?? config.children.model,
		thinking: (override?.thinking ?? config.children.thinking) as ThinkingLevel | false | undefined,
		inheritedModel: config.children.model,
		inheritedThinking: config.children.thinking as ThinkingLevel | false | undefined,
		allowCurrentModel: false,
	};
}

function assertProspectiveTargetSupported(ctx: ExtensionContext, target: WatchdogTargetState, patch: WatchdogModelPatch, source: string): void {
	const model = patch.model === null ? target.inheritedModel : patch.model ?? target.model;
	const thinking = patch.thinking === null ? target.inheritedThinking : patch.thinking ?? target.thinking;
	assertWatchdogConfigurationSupported(ctx, model, thinking, source, { allowCurrentModel: target.allowCurrentModel });
}

function resolveConfiguredValue(
	ctx: ExtensionContext,
	params: WatchdogToolParams,
	target: WatchdogTargetState,
): { model?: string | null; thinking?: ThinkingLevel | false | null; description: string } {
	const thinking = parseThinking(params.thinking);
	const rawModel = params.model?.trim();
	if (!rawModel) {
		if (thinking === undefined) throw new Error("watchdog.configure requires model, thinking, or both.");
		const value = { thinking, description: `thinking ${thinking === null ? "inherit" : thinking === false ? "off" : thinking}` };
		assertProspectiveTargetSupported(ctx, target, value, "watchdog.configure thinking");
		return value;
	}
	if (rawModel === "inherit") {
		const value = { model: null, thinking: thinking ?? null, description: "inherit" };
		assertProspectiveTargetSupported(ctx, target, value, "watchdog.configure inherit");
		return value;
	}
	if (rawModel === "recommended") {
		const recommendation = recommendStrongWatchdogModel(ctx);
		const value = {
			model: recommendation.model,
			thinking: recommendation.thinking,
			description: `${recommendation.model}:${recommendation.thinking}`,
		};
		assertProspectiveTargetSupported(ctx, target, value, "watchdog.configure recommended model");
		return value;
	}
	const resolved = resolveWatchdogModelInput(ctx, rawModel);
	const effectiveThinking = resolved.thinking ?? thinking;
	const value = {
		model: resolved.model,
		thinking: effectiveThinking,
		description: `${resolved.model}${effectiveThinking ? `:${effectiveThinking}` : ""}`,
	};
	assertProspectiveTargetSupported(ctx, target, value, "watchdog.configure model");
	return value;
}

function buildRecommendationText(ctx: ExtensionContext): string {
	const recommendation = recommendStrongWatchdogModel(ctx);
	return [
		"Subagent watchdog recommended model",
		`Recommended: ${recommendation.model}:${recommendation.thinking}`,
		`Reason: ${recommendation.reason}`,
		"Apply temporarily with subagent({ action: \"watchdog.configure\", scope: \"session\", model: \"recommended\" }).",
		"Persist with scope: \"project\" or scope: \"user\" only when the user asks for that scope.",
	].join("\n");
}

function buildCheckText(runtime: MainWatchdogRuntime | undefined, ctx: ExtensionContext): string {
	if (!runtime) return "Subagent watchdog runtime is unavailable.";
	const snapshot = runtime.getSnapshot(ctx.cwd);
	if (!snapshot.configOk) return ["Subagent watchdog config check", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`)].join("\n");
	assertWatchdogResolvedConfigurationSupported(ctx, snapshot.config, "watchdog.check");
	const lines = ["Subagent watchdog config check", "Config: ok"];
	if (snapshot.config.main.model) {
		const resolved = resolveWatchdogModelInput(ctx, snapshot.config.main.model);
		lines.push(`Main model: ${resolved.model} auth ok`);
	} else {
		lines.push("Main model: current session");
	}
	lines.push(`LSP diagnostics: ${snapshot.lsp.enabled ? "on" : "off"} · ${snapshot.lsp.status}`);
	try {
		const recommendation = recommendStrongWatchdogModel(ctx);
		lines.push(`Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking}`);
	} catch (error) {
		lines.push(`Recommended strong watchdog unavailable: ${messageFromError(error)}`);
	}
	return lines.join("\n");
}

export function handleWatchdogToolAction(action: string, params: WatchdogToolParams, ctx: ExtensionContext, runtime?: MainWatchdogRuntime): AgentToolResult<Details> {
	try {
		if (action === "watchdog.status") {
			if (!runtime) return result("Subagent watchdog runtime is unavailable.", true);
			return result(buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx));
		}
		if (action === "watchdog.recommend-model") return result(buildRecommendationText(ctx));
		if (action === "watchdog.check") return result(buildCheckText(runtime, ctx));
		if (action !== "watchdog.configure") return result(`Unknown watchdog action: ${action}`, true);

		const scope = parseScope(params.scope);
		const target = parseTarget(params);
		const value = resolveConfiguredValue(ctx, params, configuredTargetState(runtime, ctx.cwd, target, scope));
		if (scope === "session") {
			if (!runtime) return result("Subagent watchdog runtime is unavailable.", true);
			if (target.kind !== "main") return result("Session-scoped watchdog.configure currently supports target='main' only.", true);
			runtime.setSessionModel({ model: value.model, thinking: value.thinking }, ctx.cwd);
			return result([
				`Subagent watchdog session model configured: ${value.description}.`,
				"No settings files were changed.",
				"",
				buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx),
			].join("\n"));
		}

		const settingsPath = writeWatchdogModelSettings({
			scope,
			cwd: ctx.cwd,
			target,
			model: value.model,
			thinking: value.thinking,
		});
		runtime?.refreshConfig(ctx.cwd);
		const targetLabel = target.kind === "child" ? `child ${target.agent}` : target.kind;
		return result([
			`Subagent watchdog ${targetLabel} model configured: ${value.description}.`,
			`Updated: ${settingsPath}`,
		].join("\n"));
	} catch (error) {
		return result(`Subagent watchdog action failed: ${messageFromError(error)}`, true);
	}
}

export const WATCHDOG_TOOL_ACTIONS = ["watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model"] as const;
export const WATCHDOG_THINKING_VALUES = ["inherit", ...THINKING_LEVELS] as const;
