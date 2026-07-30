export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface RegistryModelLike {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		api: model.api,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. no model was specified, or the model has no suffix and no config was provided). */
export function resolveEffectiveThinking(model: string | undefined, configThinking: string | false | undefined): string | undefined {
	if (!model) return undefined;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	if (thinkingSuffix) return thinkingSuffix.slice(1);
	return THINKING_LEVELS.find((level) => level === configThinking);
}

export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: `:${suffix}`,
	};
}

export function findModelInfo(model: string | undefined, availableModels: readonly ModelInfo[] | undefined, preferredProvider?: string): ModelInfo | undefined {
	if (!model || !availableModels || availableModels.length === 0) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact;

	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferred = matches.find((entry) => entry.provider === preferredProvider);
		if (preferred) return preferred;
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model) return THINKING_LEVELS.filter((level) => level !== "max");
	if (model.reasoning === false) return ["off"];

	if (!model.thinkingLevelMap) return THINKING_LEVELS.filter((level) => level !== "max");

	const levels = THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		// Preserve legacy fallback through xhigh; max is opt-in per model.
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
	return levels;
}

export function applyThinkingSuffix(model: string, thinking: string | false | undefined, replaceExisting?: boolean): string;
export function applyThinkingSuffix(model: undefined, thinking: string | false | undefined, replaceExisting?: boolean): undefined;
export function applyThinkingSuffix(model: string | undefined, thinking: string | false | undefined, replaceExisting?: boolean): string | undefined;
export function applyThinkingSuffix(model: string | undefined, thinking: string | false | undefined, replaceExisting = false): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && (THINKING_LEVELS as readonly string[]).includes(model.substring(colonIdx + 1))) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

/** Reject max unless the resolved Pi registry entry explicitly advertises it. */
export function assertMaxThinkingSuffixSupported(
	model: string | undefined,
	availableModels: readonly ModelInfo[] | undefined,
	preferredProvider: string | undefined,
	source: string,
): void {
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model ?? "");
	if (thinkingSuffix !== ":max") return;
	const modelInfo = findModelInfo(model, availableModels, preferredProvider);
	if (getSupportedThinkingLevels(modelInfo).includes("max")) return;
	throw new Error(`${source} model '${baseModel}' does not support thinking 'max'; Pi model metadata must advertise thinkingLevelMap.max.`);
}

export function applyMetadataGatedThinkingSuffix(model: string, thinking: string | false | undefined, replaceExisting: boolean, availableModels: readonly ModelInfo[] | undefined, preferredProvider: string | undefined, source: string): string;
export function applyMetadataGatedThinkingSuffix(model: undefined, thinking: string | false | undefined, replaceExisting: boolean, availableModels: readonly ModelInfo[] | undefined, preferredProvider: string | undefined, source: string): undefined;
export function applyMetadataGatedThinkingSuffix(model: string | undefined, thinking: string | false | undefined, replaceExisting: boolean, availableModels: readonly ModelInfo[] | undefined, preferredProvider: string | undefined, source: string): string | undefined;
export function applyMetadataGatedThinkingSuffix(
	model: string | undefined,
	thinking: string | false | undefined,
	replaceExisting: boolean,
	availableModels: readonly ModelInfo[] | undefined,
	preferredProvider: string | undefined,
	source: string,
): string | undefined {
	const result = applyThinkingSuffix(model, thinking, replaceExisting);
	assertMaxThinkingSuffixSupported(result, availableModels, preferredProvider, source);
	return result;
}
