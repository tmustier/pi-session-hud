export const AUTO_COMPACT_POLICY_REQUEST_EVENT = "pi-auto-compact:policy-request:v1";
export const AUTO_COMPACT_POLICY_EVENT = "pi-auto-compact:policy:v1";

export type ModelIdentity = {
	api: string;
	provider: string;
	id: string;
};

export type AutoCompactPolicySnapshot = {
	protocolVersion: 1;
	model: ModelIdentity;
	thresholdTokens: number;
	source: string;
	configPath: string;
	configError?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAutoCompactPolicySnapshot(value: unknown): AutoCompactPolicySnapshot | undefined {
	if (!isRecord(value) || value.protocolVersion !== 1 || !isRecord(value.model)) return undefined;
	const { api, provider, id } = value.model;
	const { thresholdTokens, source, configPath, configError } = value;
	if (typeof api !== "string" || typeof provider !== "string" || typeof id !== "string") return undefined;
	if (typeof thresholdTokens !== "number" || !Number.isSafeInteger(thresholdTokens) || thresholdTokens < 0) return undefined;
	if (typeof source !== "string" || typeof configPath !== "string") return undefined;
	if (configError !== undefined && typeof configError !== "string") return undefined;

	return {
		protocolVersion: 1,
		model: { api, provider, id },
		thresholdTokens,
		source,
		configPath,
		...(configError !== undefined ? { configError } : {}),
	};
}

export function sameModel(left: ModelIdentity, right: ModelIdentity): boolean {
	return left.api === right.api && left.provider === right.provider && left.id === right.id;
}

export function effectiveContextWindow(providerContextWindow: number, autoCompactThreshold?: number): number {
	if (autoCompactThreshold === undefined) return providerContextWindow;
	if (providerContextWindow > 0 && autoCompactThreshold >= providerContextWindow) return providerContextWindow;
	return autoCompactThreshold;
}

export function effectiveContextPercent(
	providerPercent: number | null,
	tokens: number | null,
	providerContextWindow: number,
	displayContextWindow: number,
): number | null {
	if (displayContextWindow === providerContextWindow) return providerPercent;
	if (tokens === null) return null;
	if (displayContextWindow === 0) return tokens > 0 ? 100 : 0;
	return (Math.max(0, tokens) / displayContextWindow) * 100;
}
