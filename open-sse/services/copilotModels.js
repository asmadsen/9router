/**
 * GitHub Copilot model catalog fetcher.
 *
 * Calls Copilot's `GET /models` endpoint to get the live catalog for an
 * authenticated account, so `/v1/models` reflects what the account can
 * actually use (e.g. newly shipped `claude-opus-4.8`, `gpt-5.5`) instead of
 * the hand-maintained static registry, which inevitably lags behind.
 *
 * Returns chat-capable models the account's policy allows. Embeddings and
 * disabled models are filtered out.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { GITHUB_COPILOT } from "../config/appConstants.js";
import { refreshCopilotToken } from "./tokenRefresh.js";
import { getGitHubCopilotEndpoints } from "../config/githubCopilot.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per credential

/** @type {Map<string, { expiresAt: number, models: any[] }>} */
const catalogCache = new Map();

function cacheKey(credentials) {
  return `${credentials?.providerSpecificData?.enterpriseUrl || "github.com"}:${credentials?.providerSpecificData?.copilotToken
    || credentials?.accessToken
    || "copilot-anonymous"}`;
}

function buildHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "editor-version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
    "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
    "user-agent": GITHUB_COPILOT.USER_AGENT,
    "x-github-api-version": GITHUB_COPILOT.API_VERSION,
  };
}

async function fetchCatalogRaw(token, providerSpecificData, signal, proxyOptions = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await proxyAwareFetch(getGitHubCopilotEndpoints(providerSpecificData).modelsUrl, {
      method: "GET",
      headers: buildHeaders(token),
      cache: "no-store",
      signal: signal || controller.signal,
    }, proxyOptions);
    if (!response.ok) {
      const err = new Error(`Copilot /models returned ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error("Copilot /models returned an invalid catalog");
    return data.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Keep only models GitHub allows in the account's model picker. Newer catalogs
// omit capabilities.type, so only reject it when it explicitly says non-chat.
export function expandCopilotCatalog(raw) {
  const seen = new Set();
  const models = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    if (m.capabilities?.type && m.capabilities.type !== "chat") continue;
    if (m.policy?.state === "disabled") continue;
    if (m.model_picker_enabled !== true) continue;
    const id = m.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const limits = m.capabilities?.limits || {};
    const supports = m.capabilities?.supports || {};
    const contextWindow = limits.max_context_window_tokens || limits.max_prompt_tokens;
    const maxOutput = limits.max_output_tokens;
    models.push({
      id,
      name: m.name || id,
      version: m.version,
      supportedEndpoints: m.supported_endpoints,
      contextLength: contextWindow,
      maxOutputTokens: maxOutput,
      capabilities: {
        ...m.capabilities,
        ...(Number.isFinite(contextWindow) ? { contextWindow } : {}),
        ...(Number.isFinite(maxOutput) ? { maxOutput } : {}),
        ...(typeof supports.tool_calls === "boolean" ? { tools: supports.tool_calls } : {}),
        ...(typeof supports.vision === "boolean" ? { vision: supports.vision } : {}),
        reasoning: supports.adaptive_thinking === true
          || Array.isArray(supports.reasoning_effort)
          || Number.isFinite(supports.max_thinking_budget),
      },
    });
  }
  return models;
}

export function getCopilotModelEndpoint(model) {
  const endpoints = Array.isArray(model?.supportedEndpoints) ? model.supportedEndpoints : [];
  if (endpoints.includes("/v1/messages")) return "messages";
  if (endpoints.includes("/responses")) return "responses";
  return "chat";
}

/**
 * Resolve the live Copilot model catalog for a connection.
 *
 * @param {object} credentials Connection record (accessToken, refreshToken,
 *   providerSpecificData {copilotToken, copilotTokenExpiresAt}).
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh] Bypass the per-credential cache.
 * @param {object}  [options.log] Logger.
 * @param {function} [options.onCredentialsRefreshed] Persist a refreshed
 *   Copilot token back to your store. Called with `{ copilotToken,
 *   copilotTokenExpiresAt }` whenever a 401 triggers a refresh.
 * @returns {Promise<{ models: object[] } | null>}
 */
export async function resolveCopilotModels(credentials, options = {}) {
  const token = credentials?.providerSpecificData?.copilotToken || credentials?.accessToken;
  if (!token) {
    options.log?.debug?.("COPILOT_MODELS", "No copilotToken/accessToken; skipping live fetch");
    return null;
  }

  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return { models: cached.models, authoritative: true };
    }
  }

  let raw;
  try {
    raw = await fetchCatalogRaw(token, credentials.providerSpecificData, options.signal, options.proxyOptions);
  } catch (err) {
    // A 401/403 means the Copilot token is stale — refresh from the GitHub
    // access token and retry once.
    if (err && (err.status === 401 || err.status === 403) && credentials.accessToken) {
      options.log?.info?.("COPILOT_MODELS", `Got ${err.status}; refreshing Copilot token`);
      const refreshed = await refreshCopilotToken(credentials.accessToken, undefined, credentials.providerSpecificData);
      if (refreshed?.token) {
        if (typeof options.onCredentialsRefreshed === "function") {
          try {
            await options.onCredentialsRefreshed({
              copilotToken: refreshed.token,
              copilotTokenExpiresAt: refreshed.expiresAt,
            });
          } catch (e) {
            options.log?.warn?.("COPILOT_MODELS", `onCredentialsRefreshed failed: ${e?.message || e}`);
          }
        }
        try {
          raw = await fetchCatalogRaw(refreshed.token, credentials.providerSpecificData, options.signal, options.proxyOptions);
        } catch (err2) {
          options.log?.warn?.("COPILOT_MODELS", `Retry after refresh failed: ${err2?.message || err2}`);
          return null;
        }
      } else {
        options.log?.warn?.("COPILOT_MODELS", "Token refresh did not return a token");
        return null;
      }
    } else {
      options.log?.warn?.("COPILOT_MODELS", `Live model fetch failed: ${err?.message || err}`);
      return null;
    }
  }

  const models = expandCopilotCatalog(raw);

  catalogCache.set(key, { expiresAt: now + CACHE_TTL_MS, models });
  return { models, authoritative: true };
}

export function clearCopilotModelCache() {
  catalogCache.clear();
}
