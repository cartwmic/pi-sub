/**
 * OpenRouter usage provider
 *
 * Reads the prepaid credits balance from the OpenRouter credits API.
 * Key sources (in order): OPENROUTER_API_KEY env, auth.json "openrouter",
 * auth.json "openrouter-stashed" (openrouter-gate's parked key).
 */

import * as path from "node:path";
import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError, apiError } from "../../errors.js";
import { createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

function loadOpenRouterApiKey(deps: Dependencies): string | undefined {
	if (deps.env.OPENROUTER_API_KEY) {
		return deps.env.OPENROUTER_API_KEY;
	}

	const authPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(authPath)) {
			const auth = JSON.parse(deps.readFile(authPath) ?? "{}");
			for (const id of ["openrouter", "openrouter-stashed"]) {
				const key = auth[id]?.key;
				if (typeof key === "string" && key.length > 0) {
					return key;
				}
			}
		}
	} catch {
		// Ignore parse errors
	}

	return undefined;
}

export class OpenRouterProvider extends BaseProvider {
	readonly name = "openrouter" as const;
	readonly displayName = "OpnRtr";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadOpenRouterApiKey(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		const apiKey = loadOpenRouterApiKey(deps);
		if (!apiKey) {
			return this.emptySnapshot(noCredentials());
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch(CREDITS_URL, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.emptySnapshot(httpError(res.status));
			}

			const data = (await res.json()) as {
				data?: {
					total_credits?: number;
					total_usage?: number;
				};
			};

			const totalCredits = data.data?.total_credits;
			const totalUsage = data.data?.total_usage;

			if (typeof totalCredits !== "number" || !Number.isFinite(totalCredits)) {
				return this.emptySnapshot(apiError("No credit data"));
			}

			const usage = typeof totalUsage === "number" && Number.isFinite(totalUsage) ? totalUsage : 0;
			const usedPercent = totalCredits > 0 ? Math.min(100, (usage / totalCredits) * 100) : 0;

			const windows: RateWindow[] = [
				{
					label: "Credits",
					usedPercent,
					usedAmount: usage,
					capAmount: totalCredits,
				},
			];

			return this.snapshot({ windows });
		} catch {
			clear();
			return this.emptySnapshot(fetchFailed());
		}
	}

	// OpenRouter doesn't have a public status page
}
