/**
 * Anthropic/Claude usage provider
 */

import * as path from "node:path";
import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { formatReset, createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";
import { getSettings } from "../../settings.js";

const ANTHROPIC_USAGE_USER_AGENT = "claude-code/2.1.0";

/**
 * Load Claude API token from various sources
 */
function loadClaudeToken(deps: Dependencies): string | undefined {
	// Explicit override via env var (useful in CI / menu bar apps)
	const envToken = deps.env.ANTHROPIC_OAUTH_TOKEN?.trim();
	if (envToken) return envToken;

	// Try pi auth.json next
	const piAuthPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(piAuthPath)) {
			const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}");
			if (data.anthropic?.access) return data.anthropic.access;
		}
	} catch {
		// Ignore parse errors
	}

	// Try macOS Keychain (Claude Code credentials)
	try {
		const keychainData = deps.execFileSync(
			"security",
			["find-generic-password", "-s", "Claude Code-credentials", "-w"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
		).trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			const scopes = parsed.claudeAiOauth?.scopes || [];
			if (scopes.includes("user:profile") && parsed.claudeAiOauth?.accessToken) {
				return parsed.claudeAiOauth.accessToken;
			}
		}
	} catch {
		// Keychain access failed
	}

	return undefined;
}

type ExtraUsageFormat = {
	symbol: string;
	decimalSeparator: "." | ",";
};

function getExtraUsageFormat(): ExtraUsageFormat {
	const settings = getSettings();
	const providerSettings = settings.providers.anthropic;
	return {
		symbol: providerSettings.extraUsageCurrencySymbol?.trim() ?? "",
		decimalSeparator: providerSettings.extraUsageDecimalSeparator === "," ? "," : ".",
	};
}

function extraCreditsToDollars(credits: number, decimalPlaces?: number): number {
	const places =
		typeof decimalPlaces === "number" && Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= 8
			? decimalPlaces
			: 2;
	return credits / 10 ** places;
}

function formatExtraUsageCredits(credits: number, format: ExtraUsageFormat, decimalPlaces?: number): string {
	const amount = extraCreditsToDollars(credits, decimalPlaces).toFixed(2);
	const formatted = format.decimalSeparator === "," ? amount.replace(".", ",") : amount;
	return format.symbol ? `${format.symbol}${formatted}` : formatted;
}

type ExtraUsageWindow = {
	utilization?: number;
	resets_at?: string;
};

type ExtraUsage = {
	is_enabled?: boolean;
	used_credits?: number;
	monthly_limit?: number;
	utilization?: number;
	decimal_places?: number;
	resets_at?: string;
	daily?: ExtraUsageWindow | null;
	weekly?: ExtraUsageWindow | null;
};

function extraUsageResetAt(extra: ExtraUsage): Date | undefined {
	const raw = extra.resets_at ?? extra.daily?.resets_at ?? extra.weekly?.resets_at;
	return raw ? new Date(raw) : undefined;
}


export class AnthropicProvider extends BaseProvider {
	readonly name = "anthropic" as const;
	readonly displayName = "Claude Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadClaudeToken(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		const token = loadClaudeToken(deps);
		if (!token) {
			return this.emptySnapshot(noCredentials());
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch("https://api.anthropic.com/api/oauth/usage", {
				headers: {
					Authorization: `Bearer ${token}`,
					"anthropic-beta": "oauth-2025-04-20",
					"User-Agent": ANTHROPIC_USAGE_USER_AGENT,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.emptySnapshot(httpError(res.status));
			}

			const data = (await res.json()) as {
				five_hour?: { utilization?: number; resets_at?: string };
				seven_day?: { utilization?: number; resets_at?: string };
				extra_usage?: ExtraUsage;
			};

			const windows: RateWindow[] = [];

			if (data.five_hour?.utilization !== undefined) {
				const resetAt = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined;
				windows.push({
					label: "5h",
					usedPercent: data.five_hour.utilization,
					resetDescription: resetAt ? formatReset(resetAt) : undefined,
					resetAt: resetAt?.toISOString(),
				});
			}

			if (data.seven_day?.utilization !== undefined) {
				const resetAt = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined;
				windows.push({
					label: "Week",
					usedPercent: data.seven_day.utilization,
					resetDescription: resetAt ? formatReset(resetAt) : undefined,
					resetAt: resetAt?.toISOString(),
				});
			}

			// Extra usage
			const extraUsageEnabled = data.extra_usage?.is_enabled === true;
			const fiveHourUsage = data.five_hour?.utilization ?? 0;

			if (extraUsageEnabled) {
				const extra = data.extra_usage!;
				const usedCredits = extra.used_credits || 0;
				const monthlyLimit = extra.monthly_limit;
				const utilization = extra.utilization || 0;
				const format = getExtraUsageFormat();
				const usedAmount = extraCreditsToDollars(usedCredits, extra.decimal_places);
				const capAmount =
					monthlyLimit && monthlyLimit > 0
						? extraCreditsToDollars(monthlyLimit, extra.decimal_places)
						: undefined;
				// "active" when 5h >= 99%, otherwise "on"
				const extraStatus = fiveHourUsage >= 99 ? "active" : "on";
				const extraResetAt = extraUsageResetAt(extra);
				let label: string;
				if (monthlyLimit && monthlyLimit > 0) {
					label = `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits, format, extra.decimal_places)}/${formatExtraUsageCredits(monthlyLimit, format, extra.decimal_places)}`;
				} else {
					label = `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits, format, extra.decimal_places)}`;
				}

				windows.push({
					label,
					usedPercent: utilization,
					usedAmount,
					capAmount,
					resetDescription: extraResetAt
						? formatReset(extraResetAt)
						: extraStatus === "active"
							? "__ACTIVE__"
							: undefined,
					resetAt: extraResetAt?.toISOString(),
				});
			}

			return this.snapshot({
				windows,
				extraUsageEnabled,
				fiveHourUsage,
			});
		} catch {
			clear();
			return this.emptySnapshot(fetchFailed());
		}
	}

}
