/**
 * Metric-set display: ordered remaining-or-spend numbers, independent of model/pin.
 *
 * Nonempty metricSet renders at most three rows:
 *   name  <name>            │  <name>
 *   left  <remaining>       │  <remaining>
 *   time  <reset>           │  <reset>
 * Provider names have their own row. A 4-column prefix names the row.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { MetricSetItem, MetricUnit, Settings } from "../settings-types.js";
import { resolveDividerColor } from "../settings-types.js";
import type { ProviderName, RateWindow, UsageSnapshot } from "../types.js";
import { isExpectedMissingData } from "../errors.js";
import { formatUsageWindowParts } from "../formatting.js";
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
	unit: MetricUnit;
};

const NAME_PREFIX = "name";
const REMAINING_PREFIX = "left";
const SPEND_PREFIX = "used";
const MIXED_PREFIX = "use";
const TIME_PREFIX = "time";

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

/**
 * Providers whose windows report spend against an API-provided cap via
 * `usedAmount`/`capAmount`. Their dollar metrics are computed from those
 * fields; `cap` stays an optional override.
 */
function usesApiCap(provider: ProviderName): boolean {
	return provider === "cursor" || provider === "openrouter";
}

function windowUsedAmount(windows: RateWindow[]): number | undefined {
	for (const window of windows) {
		if (typeof window.usedAmount === "number" && Number.isFinite(window.usedAmount)) {
			return window.usedAmount;
		}
	}
	return undefined;
}

function windowCapAmount(item: MetricSetItem, windows: RateWindow[]): number | undefined {
	if (hasPositiveCap(item.cap)) return item.cap;
	for (const window of windows) {
		if (hasPositiveCap(window.capAmount)) return window.capAmount;
	}
	return undefined;
}

/**
 * Remaining defaults to percent. Spend defaults to dollars.
 * A configured cap without an explicit unit keeps the previous dollars path.
 */
export function metricSetUnit(item: MetricSetItem): MetricUnit {
	if (item.unit === "percent" || item.unit === "dollars") return item.unit;
	if (item.display === "spend") return "dollars";
	if (hasPositiveCap(item.cap)) return "dollars";
	return "percent";
}

/**
 * Short subscription name for a metric-set fragment.
 * Anthropic is labeled Claude to match the product name users expect.
 */
export function metricSetProviderLabel(usage: UsageSnapshot): string {
	switch (usage.provider) {
		case "anthropic":
			return "Claude";
		case "codex":
			return "Codex";
		case "cursor":
			return "Cursor";
		case "copilot":
			return "Copilot";
		case "gemini":
			return "Gemini";
		case "antigravity":
			return "Antigravity";
		case "kiro":
			return "Kiro";
		case "zai":
			return "z.ai";
		case "openrouter":
			return "OpnRtr";
		default:
			break;
	}
	const raw = usage.displayName?.trim() ?? "";
	const stripped = raw.replace(/\s+(plan|subscription|sub\.?)[\s]*$/i, "").trim();
	return stripped || raw || usage.provider;
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

function padVisible(text: string, width: number): string {
	const extra = width - visibleWidth(text);
	return extra > 0 ? `${text}${" ".repeat(extra)}` : text;
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

	const visible = snapshot.windows.filter((window) => shouldShowWindow(snapshot, window, settings));
	if (visible.length === 0) return undefined;

	const invertUsage = item.display === "remaining";
	const unit = metricSetUnit(item);
	const hasApiCap = usesApiCap(item.provider);

	if (hasApiCap && unit === "dollars") {
		const usedAmount = windowUsedAmount(snapshot.windows);
		const capAmount = windowCapAmount(item, snapshot.windows);
		if (typeof usedAmount !== "number" || !Number.isFinite(usedAmount) || !hasPositiveCap(capAmount)) {
			return undefined;
		}
		const usedPercent = (usedAmount / capAmount) * 100;
		const source = visible[0];
		const remaining = Math.max(0, capAmount - usedAmount);
		const label =
			item.display === "spend"
				? `${formatDollars(usedAmount)}/${formatDollars(capAmount)}`
				: formatDollars(remaining);
		const window: RateWindow = {
			...source,
			usedPercent,
			usedAmount,
			capAmount,
			label,
		};
		return [{ window, invertUsage, usage: snapshot, unit }];
	}

	// Percent must not inherit spend titles from the provider or a stale cache.
	return visible.map((window) => ({
		window: hasApiCap ? { ...window, label: "" } : window,
		invertUsage,
		usage: snapshot,
		unit,
	}));
}

function isDollarLabel(label: string): boolean {
	return /^\$/.test(label.trim());
}

function compactWindowParts(
	theme: Theme,
	entry: PreparedMetricWindow,
	settings: Settings,
) {
	const dollarLabel = entry.unit === "dollars" && isDollarLabel(entry.window.label);
	return formatUsageWindowParts(
		theme,
		entry.window,
		entry.invertUsage,
		{
			...settings,
			display: {
				...settings.display,
				barStyle: "percentage",
				showWindowTitle: dollarLabel,
				showUsageLabels: false,
				resetTimePosition: "back",
				resetTimeContainment: "none",
			},
		},
		entry.usage,
	);
}

type MetricColumn = {
	name: string;
	remaining: string;
	time: string;
	display: MetricSetItem["display"];
};

function collectMetricColumns(
	theme: Theme,
	metricSet: MetricSetItem[],
	snapshots: UsageEntryMap,
	settings: Settings,
): MetricColumn[] {
	const columns: MetricColumn[] = [];
	for (const item of metricSet) {
		const prepared = prepareMetricSetItem(item, snapshots[item.provider], settings);
		if (!prepared) continue;
		const name = metricSetProviderLabel(prepared[0]?.usage ?? snapshots[item.provider]!);
		const remainingBits: string[] = [];
		const timeBits: string[] = [];
		for (const entry of prepared) {
			const parts = compactWindowParts(theme, entry, settings);
			const dollarLabel = entry.unit === "dollars" && isDollarLabel(entry.window.label);
			const remaining = dollarLabel && parts.label ? parts.label : parts.pct;
			if (remaining) remainingBits.push(remaining);
			if (parts.reset) timeBits.push(parts.reset);
		}
		if (remainingBits.length === 0) continue;
		columns.push({
			name,
			remaining: remainingBits.join("/"),
			time: timeBits.length > 0 ? timeBits.join("/") : "—",
			display: item.display,
		});
	}
	return columns;
}

function usageRowPrefix(columns: MetricColumn[]): string {
	const kinds = new Set(columns.map((column) => column.display));
	if (kinds.size > 1) return MIXED_PREFIX;
	if (kinds.has("spend")) return SPEND_PREFIX;
	return REMAINING_PREFIX;
}

/**
 * Three-row metric-set layout. Row 1 is provider names, row 2 is remaining/spend,
 * row 3 is reset time. A short prefix column labels each row. Never returns more
 * than three lines.
 */
export function formatMetricSetLines(
	theme: Theme,
	metricSet: MetricSetItem[],
	snapshots: UsageEntryMap,
	settings: Settings,
	_model?: { provider?: string; id?: string },
): string[] | undefined {
	if (metricSet.length === 0) return undefined;
	const columns = collectMetricColumns(theme, metricSet, snapshots, settings);
	if (columns.length === 0) return undefined;

	const remainingPrefix = usageRowPrefix(columns);
	const prefixWidth = Math.max(
		visibleWidth(NAME_PREFIX),
		visibleWidth(remainingPrefix),
		visibleWidth(TIME_PREFIX),
	);
	const divider = usageDivider(theme, settings);
	const widths = columns.map((column) => Math.max(
		visibleWidth(column.name),
		visibleWidth(column.remaining),
		visibleWidth(column.time),
	));

	const formatRow = (prefix: string, pick: (column: MetricColumn) => string) =>
		`${theme.fg("dim", padVisible(prefix, prefixWidth))} ${columns
			.map((column, index) => padVisible(pick(column), widths[index] ?? 0))
			.join(divider)}`;
	return [
		formatRow(NAME_PREFIX, (column) => column.name),
		formatRow(remainingPrefix, (column) => column.remaining),
		formatRow(TIME_PREFIX, (column) => column.time),
	];
}

/**
 * Render a nonempty metricSet as three newline-joined rows (names, remaining,
 * then time). Membership follows list order only. Unusable items are omitted.
 * Each column shows its subscription name on the name row and keeps its position
 * on the remaining and time rows.
 */
export function formatMetricSet(
	theme: Theme,
	metricSet: MetricSetItem[],
	snapshots: UsageEntryMap,
	settings: Settings,
	model?: { provider?: string; id?: string },
): string | undefined {
	const lines = formatMetricSetLines(theme, metricSet, snapshots, settings, model);
	return lines?.join("\n");
}
