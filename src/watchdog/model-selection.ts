import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeModelSegment, resolveModelCandidate } from "../runs/shared/model-fallback.ts";
import {
	getSupportedThinkingLevels,
	splitKnownThinkingSuffix,
	THINKING_LEVELS,
	toModelInfo,
	type ModelInfo,
	type ThinkingLevel,
} from "../shared/model-info.ts";
import type { ResolvedWatchdogConfig } from "./types.ts";

export const STRONG_WATCHDOG_THINKING: ThinkingLevel = "high";

const STRONG_WATCHDOG_MODELS = {
	opus48: {
		label: "Opus 4.8",
		queries: [
			"anthropic/claude-opus-4-8",
			"anthropic/claude-opus-4.8",
			"anthropic/opus-4-8",
			"anthropic/opus-4.8",
		],
	},
	gpt55: {
		label: "GPT 5.5",
		queries: [
			"openai-codex/gpt-5.5",
			"openai-codex/gpt-5-5",
			"openai/gpt-5.5",
			"openai/gpt-5-5",
		],
	},
} as const;

type StrongWatchdogFamily = keyof typeof STRONG_WATCHDOG_MODELS;

type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["find"]>;

export interface ResolvedWatchdogModelInput {
	model: string;
	thinking?: ThinkingLevel;
	registryModel: NonNullable<RegistryModel>;
}

export interface WatchdogModelRecommendation {
	model: string;
	thinking: ThinkingLevel;
	label: string;
	reason: string;
	registryModel: NonNullable<RegistryModel>;
}

function fullModelId(model: Pick<ModelInfo, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function modelRegistryEntries(ctx: ExtensionContext): ModelInfo[] {
	return ctx.modelRegistry.getAvailable().map(toModelInfo);
}

function splitProviderModel(value: string): { provider: string; id: string } | undefined {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined;
	return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
}

function assertSupportedThinking(value: string, source: string): ThinkingLevel {
	if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	throw new Error(`Unsupported watchdog thinking '${value}' from ${source}; expected ${THINKING_LEVELS.join(", ")}, false, or inherit.`);
}

export function parseWatchdogThinkingInput(value: string | false | undefined, source = "watchdog input"): ThinkingLevel | false | undefined {
	if (value === undefined || value === "") return undefined;
	if (value === false) return false;
	if (value === "false") return false;
	return assertSupportedThinking(value, source);
}

/** Max is accepted only when the active Pi model registry explicitly advertises it. */
export function assertWatchdogThinkingSupported(model: ModelInfo, thinking: ThinkingLevel, source: string): ThinkingLevel {
	if (thinking !== "max" || getSupportedThinkingLevels(model).includes("max")) return thinking;
	throw new Error(`Watchdog model '${model.fullId}' does not support thinking '${thinking}' from ${source}; Pi model metadata must advertise thinkingLevelMap.max.`);
}

export function assertWatchdogConfigurationSupported(
	ctx: ExtensionContext,
	model: string | undefined,
	thinking: ThinkingLevel | false | undefined,
	source: string,
	options: { allowCurrentModel?: boolean } = {},
): void {
	const resolved = model ? resolveWatchdogModelInput(ctx, model) : undefined;
	const effectiveThinking = resolved?.thinking ?? thinking;
	if (effectiveThinking !== "max") return;
	const currentModel = resolved?.registryModel ?? (options.allowCurrentModel === false ? undefined : ctx.model);
	if (!currentModel) {
		const requirement = options.allowCurrentModel === false
			? "requires an explicit max-capable model."
			: "requires a resolved model with thinkingLevelMap.max metadata.";
		throw new Error(`Watchdog thinking 'max' from ${source} ${requirement}`);
	}
	assertWatchdogThinkingSupported(toModelInfo(currentModel), effectiveThinking, source);
}

export function watchdogConfigurationValidationErrors(
	ctx: ExtensionContext,
	config: ResolvedWatchdogConfig,
	source: string,
): string[] {
	const errors: string[] = [];
	const validate = (label: string, model: string | undefined, thinking: string | false | undefined, allowCurrentModel: boolean): void => {
		try {
			assertWatchdogConfigurationSupported(ctx, model, thinking as ThinkingLevel | false | undefined, `${source} ${label}`, { allowCurrentModel });
		} catch (error) {
			errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	validate("main", config.main.model, config.main.thinking, true);
	validate("children", config.children.model, config.children.thinking, false);
	for (const [agent, override] of Object.entries(config.children.overrides)) {
		validate(`child '${agent}'`, override.model ?? config.children.model, override.thinking ?? config.children.thinking, false);
	}
	return errors;
}

export function assertWatchdogResolvedConfigurationSupported(ctx: ExtensionContext, config: ResolvedWatchdogConfig, source: string): void {
	const errors = watchdogConfigurationValidationErrors(ctx, config, source);
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

export function resolveWatchdogModelInput(ctx: ExtensionContext, rawModel: string): ResolvedWatchdogModelInput {
	const trimmed = rawModel.trim();
	if (!trimmed) throw new Error("Watchdog model must be a non-empty provider/model value.");
	const availableModels = modelRegistryEntries(ctx);
	const preferredProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined;
	const resolved = resolveModelCandidate(trimmed, availableModels, preferredProvider) ?? trimmed;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(resolved);
	const named = splitProviderModel(baseModel);
	if (!named) throw new Error(`Watchdog model '${rawModel}' did not resolve to provider/model. Use a provider-qualified model such as openai-codex/gpt-5.5:high or anthropic/claude-opus-4-8:high.`);
	const registryModel = ctx.modelRegistry.find(named.provider, named.id);
	if (!registryModel) throw new Error(`Watchdog model '${rawModel}' was not found as '${baseModel}'.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(registryModel)) {
		throw new Error(`Watchdog model '${baseModel}' is not authenticated. Configure credentials for provider '${named.provider}' or choose an authenticated model.`);
	}
	const modelInfo = toModelInfo(registryModel);
	const thinking = thinkingSuffix
		? assertWatchdogThinkingSupported(modelInfo, assertSupportedThinking(thinkingSuffix.slice(1), "watchdog model suffix"), "watchdog model suffix")
		: undefined;
	return {
		model: `${named.provider}/${named.id}`,
		...(thinking ? { thinking } : {}),
		registryModel,
	};
}

function familyForModel(model: Pick<ModelInfo, "provider" | "id"> | undefined): StrongWatchdogFamily | undefined {
	if (!model) return undefined;
	const provider = normalizeModelSegment(model.provider);
	const id = normalizeModelSegment(model.id);
	if (provider.includes("openai") && /^gpt-5-5(-\d{8}|-\d{4}-\d{2}-\d{2})?$/.test(id)) return "gpt55";
	if (provider.includes("anthropic") && /^(claude-opus-4-8|opus-4-8)(-\d{8}|-\d{4}-\d{2}-\d{2})?$/.test(id)) return "opus48";
	return undefined;
}

function currentProviderFamily(ctx: ExtensionContext): "openai" | "anthropic" | undefined {
	const provider = typeof ctx.model?.provider === "string" ? normalizeModelSegment(ctx.model.provider) : "";
	if (provider.includes("openai")) return "openai";
	if (provider.includes("anthropic")) return "anthropic";
	return undefined;
}

function strongFamilyOrder(ctx: ExtensionContext): StrongWatchdogFamily[] {
	const current = ctx.model ? familyForModel(toModelInfo(ctx.model)) : undefined;
	if (current === "gpt55") return ["opus48"];
	if (current === "opus48") return ["gpt55"];
	const providerFamily = currentProviderFamily(ctx);
	if (providerFamily === "openai") return ["opus48", "gpt55"];
	if (providerFamily === "anthropic") return ["gpt55", "opus48"];
	return ["gpt55", "opus48"];
}

function findFamilyMatch(family: StrongWatchdogFamily, availableModels: ModelInfo[]): string | undefined {
	const matches = availableModels.filter((entry) => familyForModel(entry) === family);
	if (matches.length === 1) return matches[0]!.fullId;
	return undefined;
}

function resolveStrongCandidate(ctx: ExtensionContext, family: StrongWatchdogFamily): WatchdogModelRecommendation | undefined {
	const availableModels = modelRegistryEntries(ctx);
	const preference = STRONG_WATCHDOG_MODELS[family];
	const queries = [...preference.queries];
	const familyMatch = findFamilyMatch(family, availableModels);
	if (familyMatch) queries.push(familyMatch);
	for (const query of queries) {
		let resolved: ResolvedWatchdogModelInput;
		try {
			resolved = resolveWatchdogModelInput(ctx, query);
		} catch {
			continue;
		}
		const modelInfo = toModelInfo(resolved.registryModel);
		if (familyForModel(modelInfo) !== family) continue;
		if (!getSupportedThinkingLevels(modelInfo).includes(STRONG_WATCHDOG_THINKING)) continue;
		const current = ctx.model ? fullModelId(toModelInfo(ctx.model)) : "no current session model";
		return {
			model: resolved.model,
			thinking: STRONG_WATCHDOG_THINKING,
			label: preference.label,
			reason: `Use ${preference.label} with thinking high as a strong independent watchdog for ${current}.`,
			registryModel: resolved.registryModel,
		};
	}
	return undefined;
}

export function recommendStrongWatchdogModel(ctx: ExtensionContext): WatchdogModelRecommendation {
	for (const family of strongFamilyOrder(ctx)) {
		const recommendation = resolveStrongCandidate(ctx, family);
		if (recommendation) return recommendation;
	}
	const current = ctx.model ? fullModelId(toModelInfo(ctx.model)) : "the current session";
	throw new Error(`No authenticated strong complementary watchdog model was found for ${current}. Configure access to Opus 4.8 or GPT 5.5, then run the recommendation again.`);
}
