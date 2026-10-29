import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { generateSessionId } from "../executors/opencode-zen.js";

const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-zen"]);

/**
 * Resolve the System One URL. A saved host override is joined with the registry
 * `path` (e.g. "/v1/systemone") without doubling a "/v1" or "/v1/systemone" the
 * user already included. Without `path`, the override is used as a full URL.
 */
export function buildSystemoneUrl(override, cfg) {
  const base = override?.trim();
  if (!base) return cfg?.baseUrl;
  if (!cfg?.path) return base;
  const host = base.replace(/\/+$/, "");
  const path = cfg.path.replace(/\/+$/, "");
  if (host.endsWith(path)) return host;
  const prefix = path.slice(0, path.lastIndexOf("/"));
  if (prefix && host.endsWith(prefix)) return host + path.slice(prefix.length);
  return host + path;
}
const VERBOSE = process.env.LOG_SYSTEMONE_VERBOSE === "1";

const maskHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) =>
      k.toLowerCase() === "authorization" ? [k, `Bearer ***${String(v).replace(/^Bearer /, "").slice(-4)}`] : [k, v]
    )
  );

/**
 * Core System One (Jev) handler — native decision payload pass-through.
 * URL/headers come from the registry's systemoneConfig; body and JSON response
 * are forwarded untouched (decision models have no chat translation layer).
 *
 * @returns {Promise<{ success: boolean, response: Response, usage?: object, status?: number, error?: string }>}
 */
export async function handleSystemoneCore({
  body,
  modelInfo,
  credentials,
  log,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;
  const isCustomNode = provider.startsWith("systemone-compatible-");
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  const nodeBaseUrl = credentials?.providerSpecificData?.baseUrl;
  let targetUrl = isCustomNode
    ? (nodeBaseUrl ? `${nodeBaseUrl.replace(/\/+$/, "")}/systemone` : null)
    : buildSystemoneUrl(nodeBaseUrl, cfg);
  if (!targetUrl) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support System One.`
    );
  }
  // Cloudflare-style endpoints embed the account and model in the path.
  if (targetUrl.includes("{accountId}")) {
    const accountId = credentials?.providerSpecificData?.accountId;
    if (!accountId) {
      return createErrorResult(
        HTTP_STATUS.BAD_REQUEST,
        `Provider '${provider}' requires accountId in providerSpecificData.`
      );
    }
    targetUrl = targetUrl.replace("{accountId}", accountId);
  }
  if (targetUrl.includes("{model}")) {
    targetUrl = targetUrl.replace(/\{model\}/g, model);
  }

  // Validate input at the trust boundary; question-level shape is upstream's job.
  if (body.state === undefined || body.state === null) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: state");
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  // noAuth free lanes carry accessToken "public" from the credential stub.
  const token = credentials?.apiKey || credentials?.accessToken;
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cfg?.headers || {}),
    // Zen lanes expect the official client session header; other providers don't need it.
    ...(!isCustomNode && OPENCODE_PROVIDERS.has(provider) ? { "x-opencode-session": generateSessionId() } : {}),
  };
  // Cloudflare validates the body model as a short selector (e.g. "clef-flash"), not the full id.
  const requestBody = { ...body, model: (!isCustomNode && getModelUpstreamId(provider, model)) || model };

  log?.debug?.("SYSTEMONE", `${provider.toUpperCase()} | ${model}`);

  if (VERBOSE) {
    console.log(`[SYSTEMONE] -> POST ${targetUrl}`, JSON.stringify({ headers: maskHeaders(headers), body: requestBody }, null, 2));
  }

  let providerResponse;
  try {
    providerResponse = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("SYSTEMONE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (VERBOSE) {
    const raw = await providerResponse.clone().text().catch(() => "");
    console.log(`[SYSTEMONE] <- ${providerResponse.status}`, raw);
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("SYSTEMONE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const usage = responseBody?.usage;
  return {
    success: true,
    usage: usage
      ? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 }
      : null,
    response: new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
