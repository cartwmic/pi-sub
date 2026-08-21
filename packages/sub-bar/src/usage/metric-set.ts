/**
 * Metric-set display: ordered remaining-or-spend numbers, independent of model/pin.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { MetricSetItem, Settings } from "../settings-types.js";
import { resolveDividerColor } from "../settings-types.js";
import type { ProviderName, RateWindow, UsageSnapshot } from "../types.js";
import { isExpectedMissingData } from "../errors.js";
import { formatUsageWindow } from "../formatting.js";
import { shouldShowWindow } from "../providers/windows.js";

export type UsageEntryMap = Partial<Record<ProviderName, UsageSnapshot>>;

export type DisplayUsageInput = {
	pinnedProvider: ProviderName | null;
	currentUsage: UsageSnapshot | undefined;
	usageEntries: UsageEntryMap;
};

type PreparedMetricWindow = {
	window: RateWindow;
	invertUsage: boolean;
	usage: UsageSnapshot;
};

function formatDollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

function hasPositiveCap(cap: number | undefined): cap is number {
	return typeof cap === "number" && Number.isFinite(cap) && cap > 0;
}

function snapshotHasCredentials(snapshot: UsageSnapshot): boolean {
	if (!snapshot.error) return true;
	return !isExpectedMissingData(snapshot.error);
}

function cursorUsedAmount(windows: RateWindow[]): number | undefined {
	for (const window of windows) {
		if (typeof window.usedAmount === "number" && Number.isFinite(window.usedAmount)) {
			return window.usedAmount;
		}
	}
	return undefined;
}

function usageDivider(theme: Theme, settings?: Settings): string {
	const dividerChar = settings?.display.dividerCharacter ?? "•";
	const dividerColor = resolveDividerColor(settings?.display.dividerColor);
	const blanksSetting = settings?.display.dividerBlanks ?? 1;
	const blanksPerSide = typeof blanksSetting === "number" ? blanksSetting : 1;
	const spacing = " ".repeat(blanksPerSide);
	const charToDisplay = dividerChar === "blank" ? " " : dividerChar === "none" ? "" : dividerChar;
	return charToDisplay ? spacing + theme.fg(dividerColor, charToDisplay) + spacing : spacing + spacing;
}

/**
 * Empty metricSet display source: pinned provider snapshot, else selected-model currentUsage.
 */
export function getDisplayUsage(input: DisplayUsageInput): UsageSnapshot | undefined {
	const pinned = input.pinnedProvider ?? null;
	if (pinned) {
		return input.usageEntries[pinned] ?? input.currentUsage;
	}
	return input.currentUsage;
}

/**
 * Merge already-fetched snapshots so a listed provider can use currentUsage
 * as a cache fill without changing set membership.
 */
export function snapshotsForMetricSet(
	usageEntries: UsageEntryMap,
	currentUsage?: UsageSnapshot,
): UsageEntryMap {
	if (!currentUsage || usageEntries[currentUsage.provider]) {
		return usageEntries;
	}
	return { ...usageEntries, [currentUsage.provider]: currentUsage };
}

function prepareMetricSetItem(
	item: MetricSetItem,
	snapshot: UsageSnapshot | undefined,
	settings: Settings,
): PreparedMetricWindow[] | undefined {
	if (!snapshot) return undefined;
	if (!snapshotHasCredentials(snapshot)) return undefined;
	if (snapshot.error) return undefined;

	const isCursor = item.provider === "cursor";
	if (isCursor && !hasPositiveCap(item.cap)) return undefined;

	const usedAmount = isCursor ? cursorUsedAmount(snapshot.windows) : undefined;
	if (isCursor && (typeof usedAmount !== "number" || !Number.isFinite(usedAmount))) {
		return undefined;
	}

	const visible = snapshot.windows.filter((window) => shouldShowWindow(snapshot, window, settings));
	if (visible.length === 0) return undefined;

	const invertUsage = item.display === "remaining";

	if (isCursor && hasPositiveCap(item.cap) && typeof usedAmount === "number") {
		const usedPercent = (usedAmount / item.cap) * 100;
		const source = visible[0];
		const label =
			item.display === "spend"
				? `${formatDollars(usedAmount)}/${formatDollars(item.cap)}`
				: formatDollars(item.cap - usedAmount);
		const window: RateWindow = {
			...source,
			usedPercent,
			usedAmount,
			label,
		};
		return [{ window, invertUsage, usage: snapshot }];
	}

	return visible.map((window) => ({ window, invertUsage, usage: snapshot }));
}

/**
 * Render a nonempty metricSet as concatenated formatUsageWindow fragments.
 * Membership follows list order only. Unusable items are omitted.
 */
export function formatMetricSet(
	theme: Theme,
	metricSet: MetricSetItem[],
	snapshots: UsageEntryMap,
	settings: Settings,
	_model?: { provider?: string; id?: string },
): string | undefined {
	if (metricSet.length === 0) return undefined;

	const parts: string[] = [];
	for (const item of metricSet) {
		const prepared = prepareMetricSetItem(item, snapshots[item.provider], settings);
		if (!prepared) continue;
		for (const entry of prepared) {
			parts.push(
				formatUsageWindow(theme, entry.window, entry.invertUsage, settings, entry.usage),
			);
		}
	}

	if (parts.length === 0) return undefined;
	return parts.join(usageDivider(theme, settings));
}
