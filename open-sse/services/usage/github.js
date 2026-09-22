/**
 * GitHub Copilot usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDER_OAUTH } from "../../providers/index.js";
import { parseResetTime } from "./shared.js";
import { getGitHubCopilotEndpoints } from "../../config/githubCopilot.js";

// GitHub API config — single source from registry oauth block
const GITHUB_CONFIG = {
  apiVersion: PROVIDER_OAUTH.github?.apiVersion,
  userAgent: PROVIDER_OAUTH.github?.userAgent,
};

/**
 * GitHub Copilot Usage
 * Uses GitHub accessToken (not copilotToken) to call copilot_internal/user API
 */
export async function getGitHubUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    if (!accessToken) {
      throw new Error("No GitHub access token available. Please re-authorize the connection.");
    }

    const usageUrl = getGitHubCopilotEndpoints(providerSpecificData).usageUrl;
    if (!usageUrl) {
      return { message: "Usage data is not available for GitHub Enterprise Copilot connections." };
    }

    // copilot_internal/user API requires GitHub OAuth token, not copilotToken
    const response = await proxyAwareFetch(usageUrl, {
      headers: {
        "Authorization": `token ${accessToken}`,
        "Accept": "application/json",
        "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        "User-Agent": GITHUB_CONFIG.userAgent,
        "Editor-Version": "vscode/1.100.0",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
      },
    }, proxyOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${error}`);
    }

    return formatGitHubUsage(await response.json());
  } catch (error) {
    throw new Error(`Failed to fetch GitHub usage: ${error.message}`);
  }
}

export function formatGitHubUsage(data) {
  if (data.quota_snapshots) {
    const resetDate = data.quota_reset_date_utc || data.quota_reset_date;
    const resetAt = parseResetTime(resetDate);

    return {
      plan: data.copilot_plan || data.access_type_sku,
      resetDate,
      quotas: Object.fromEntries(
        Object.entries(data.quota_snapshots).map(([name, quota]) => [
          name,
          { ...formatGitHubQuotaSnapshot(quota), resetAt },
        ]),
      ),
    };
  }

  if (data.monthly_quotas || data.limited_user_quotas) {
    const monthlyQuotas = data.monthly_quotas || {};
    const remainingQuotas = data.limited_user_quotas || {};
    const resetDate = data.limited_user_reset_date;
    const resetAt = parseResetTime(resetDate);
    const quotaNames = new Set([...Object.keys(monthlyQuotas), ...Object.keys(remainingQuotas)]);

    return {
      plan: data.copilot_plan || data.access_type_sku,
      resetDate,
      quotas: Object.fromEntries([...quotaNames].map((name) => {
        const total = toFiniteNumber(monthlyQuotas[name]) ?? 0;
        const remaining = toFiniteNumber(remainingQuotas[name]) ?? 0;
        return [name, {
          used: Math.max(0, total - remaining),
          total,
          remaining,
          unlimited: false,
          resetAt,
        }];
      })),
    };
  }

  return { message: "GitHub Copilot connected. Unable to parse quota data." };
}

function formatGitHubQuotaSnapshot(quota) {
  if (!quota) return { used: 0, total: 0, unlimited: true };

  const entitlement = toFiniteNumber(quota.entitlement) ?? 0;
  const unlimited = quota.unlimited === true || entitlement === -1;
  const total = unlimited ? 0 : Math.max(0, entitlement);
  const explicitRemaining = toFiniteNumber(quota.remaining);
  const percentRemaining = toFiniteNumber(quota.percent_remaining);
  const remaining = explicitRemaining ?? (percentRemaining == null ? total : total * percentRemaining / 100);
  const creditsUsed = toFiniteNumber(quota.credits_used);

  return {
    used: unlimited ? 0 : Math.max(0, creditsUsed ?? total - remaining),
    total,
    remaining: unlimited ? 0 : remaining,
    unlimited,
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
