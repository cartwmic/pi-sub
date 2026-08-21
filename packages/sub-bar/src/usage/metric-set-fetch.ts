/**
 * When metricSet is nonempty, listed providers must be fetched even if they
 * are not the selected model. Cache-only entry reads omit them on a fresh or
 * expired cache; UI and headless starts therefore share a forced, long-timeout
 * entries request.
 */

import { isExpectedMissingData } from "../errors.js";
import type { MetricSetItem } from "../settings-types.js";
import type { UsageEntryMap } from "./metric-set.js";

export function metricSetEntriesRequest(
	metricSetLength: number,
): { timeoutMs: number; force: true } | null {
	if (metricSetLength <= 0) return null;
	return { timeoutMs: 45_000, force: true };
}

/**
 * Refetch when a listed provider is missing, or when last-good data is older
 * than the refresh interval. Expected missing-auth snapshots are not retried.
 */
export function metricSetNeedsRefresh(
	metricSet: Pick<MetricSetItem, "provider">[],
	usageEntries: UsageEntryMap,
	nowMs: number,
	ttlMs: number,
): boolean {
	if (metricSet.length <= 0) return false;
	return metricSet.some((item) => {
		const snapshot = usageEntries[item.provider];
		if (!snapshot) return true;
		if (snapshot.error && isExpectedMissingData(snapshot.error)) return false;
		if (typeof snapshot.lastSuccessAt !== "number") return true;
		return nowMs - snapshot.lastSuccessAt >= ttlMs;
	});
}
