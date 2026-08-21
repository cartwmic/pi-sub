/**
 * Merge provider snapshots so metric-set display can keep last-good values
 * when a refresh omits a provider (expired TTL) or returns a transient error.
 */

import type { ProviderUsageEntry, UsageSnapshot } from "../types.js";
import { isExpectedMissingData } from "../errors.js";
import type { UsageEntryMap } from "./metric-set.js";

export function hasUsableWindows(snapshot: UsageSnapshot | undefined): snapshot is UsageSnapshot {
	return Boolean(
		snapshot
		&& Array.isArray(snapshot.windows)
		&& snapshot.windows.length > 0
		&& !(snapshot.error && isExpectedMissingData(snapshot.error)),
	);
}

function stampLastSuccess(incoming: UsageSnapshot, previous?: UsageSnapshot): UsageSnapshot {
	if (typeof incoming.lastSuccessAt === "number") return incoming;
	if (typeof previous?.lastSuccessAt === "number") {
		return { ...incoming, lastSuccessAt: previous.lastSuccessAt };
	}
	if (!incoming.error && hasUsableWindows(incoming)) {
		return { ...incoming, lastSuccessAt: Date.now() };
	}
	return incoming;
}

/**
 * Prefer a usable incoming snapshot. Keep previous windows when the incoming
 * payload is a transient failure without windows. Expected missing-auth
 * snapshots replace previous so the metric set can omit that provider.
 */
export function pickUsageSnapshot(
	previous: UsageSnapshot | undefined,
	incoming: UsageSnapshot,
): UsageSnapshot {
	const next = stampLastSuccess(incoming, previous);
	if (next.error && isExpectedMissingData(next.error)) return next;
	if (hasUsableWindows(next)) return next;
	if (hasUsableWindows(previous)) return previous;
	return next;
}

/**
 * Overlay incoming entries onto the previous map. Providers absent from
 * `incoming` stay put (cache TTL omission must not blank the widget).
 */
export function mergeUsageEntries(
	previous: UsageEntryMap,
	incoming: ProviderUsageEntry[] | undefined,
): UsageEntryMap {
	if (!incoming) return previous;
	const next: UsageEntryMap = { ...previous };
	for (const entry of incoming) {
		if (!entry.usage) continue;
		next[entry.provider] = pickUsageSnapshot(previous[entry.provider], entry.usage);
	}
	return next;
}
