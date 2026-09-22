/** Pi's own auto-compaction lowers how much of the context window a session can use. */

import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** The part of Pi's settings the HUD reads; Pi owns model overrides, the project merge and defaults. */
export type CompactionSettingsReader = Pick<SettingsManager, "getCompactionSettings">;

export type CompactionModel = { provider: string; id: string };

/**
 * Load the settings Pi's compaction trigger reads for this session, or null when they are
 * unreadable. This is a snapshot: a settings edit lands on the next session or `/reload`.
 */
export function readCompactionSettings(cwd: string, projectTrusted: boolean): CompactionSettingsReader | null {
	try {
		return SettingsManager.create(cwd, undefined, { projectTrusted });
	} catch {
		return null;
	}
}

/**
 * Pi compacts when `contextTokens > contextWindow - reserveTokens`, so a large reserve makes a
 * session compact well short of the provider window. Return that trigger point, or undefined when
 * it does not bind: compaction off, an unknown window, or a reserve that covers the whole window.
 */
export function nativeCompactionThreshold(
	settings: CompactionSettingsReader | null,
	model: CompactionModel | undefined,
	providerContextWindow: number,
): number | undefined {
	if (!settings || !model || providerContextWindow <= 0) return undefined;

	let compaction: { enabled: boolean; reserveTokens: number };
	try {
		compaction = settings.getCompactionSettings(model);
	} catch {
		// Pi reports invalid compaction settings itself; the HUD keeps showing the provider window.
		return undefined;
	}
	if (!compaction.enabled) return undefined;

	const threshold = providerContextWindow - compaction.reserveTokens;
	return threshold > 0 ? threshold : undefined;
}

/** A session compacts at whichever configured threshold it reaches first. */
export function bindingThreshold(...thresholds: (number | undefined)[]): number | undefined {
	let binding: number | undefined;
	for (const threshold of thresholds) {
		if (threshold === undefined) continue;
		if (binding === undefined || threshold < binding) binding = threshold;
	}
	return binding;
}
