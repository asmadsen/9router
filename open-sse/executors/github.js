import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { GITHUB_COPILOT } from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState, translateRequest, translateResponse } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import crypto from "crypto";
import { getGitHubCopilotEndpoints } from "../config/githubCopilot.js";
import { getCopilotModelEndpoint, resolveCopilotModels } from "../services/copilotModels.js";

function makeNullable(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((entry) => entry?.type === "null")
      ? schema
      : { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

export function normalizeCopilotToolSchema(schema, optional = false) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  let normalized = { ...schema };
  if (Array.isArray(normalized.enum) && Array.isArray(normalized.oneOf)
    && normalized.oneOf.every((entry) => entry && Object.prototype.hasOwnProperty.call(entry, "const"))) {
    const choiceDescriptions = normalized.oneOf
      .filter((entry) => entry.description)
      .map((entry) => `${JSON.stringify(entry.const)}: ${entry.description}`)
      .join("; ");
    if (choiceDescriptions) {
      normalized.description = [normalized.description, `Values: ${choiceDescriptions}`].filter(Boolean).join("\n");
    }
    delete normalized.oneOf;
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(normalized[keyword])) {
      normalized[keyword] = normalized[keyword].map((entry) => normalizeCopilotToolSchema(entry));
    }
  }
  if (normalized.items) normalized.items = normalizeCopilotToolSchema(normalized.items);

  if (normalized.type === "object" || normalized.properties) {
    const properties = normalized.properties || {};
    const originallyRequired = new Set(Array.isArray(normalized.required) ? normalized.required : []);
    normalized.properties = Object.fromEntries(Object.entries(properties).map(([name, propertySchema]) => [
      name,
      normalizeCopilotToolSchema(propertySchema, !originallyRequired.has(name)),
    ]));
    normalized.required = Object.keys(properties);
    normalized.additionalProperties = false;
  }

  return optional ? makeNullable(normalized) : normalized;
}

export class GithubExecutor extends BaseExecutor {
  constructor() {
    super("github", PROVIDERS.github);
    this.knownCodexModels = new Set();
  }

  // Claude models get routed to Copilot's Anthropic-native /v1/messages shim (see
  // executeWithMessagesEndpoint below) — the only Copilot endpoint that surfaces
  // prompt-cache token counts. gpt/gemini/grok models stay on /chat/completions
  // (or /responses). Name-pattern check, not a registry field: Copilot's live model
  // catalog (services/copilotModels.js) regularly exposes claude-* variants ahead
  // of the static registry (registry/github.js).
  isClaudeModel(model) {
    return /claude/i.test(model || "");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return getGitHubCopilotEndpoints(credentials?.providerSpecificData).chatCompletionsUrl;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials.copilotToken || credentials.accessToken;
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "copilot-integration-id": "vscode-chat",
      "editor-version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
      "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
      "user-agent": GITHUB_COPILOT.USER_AGENT,
      "openai-intent": "conversation-panel",
      "x-github-api-version": GITHUB_COPILOT.API_VERSION,
      "x-request-id": crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "x-vscode-user-agent-library-version": "electron-fetch",
      "X-Initiator": "user",
      // Harmless no-op on /chat/completions and /responses; required by /v1/messages.
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Accept": stream ? "text/event-stream" : "application/json"
    };
  }

  // Sanitize messages for GitHub Copilot /chat/completions endpoint (gpt/gemini/grok models —
  // claude models never reach this, see execute() below).
  // The endpoint only accepts 'text' and 'image_url' content part types.
  // Tool-related content (tool_use, tool_result, thinking) must be serialized as text.
  sanitizeMessagesForChatCompletions(body) {
    if (!body?.messages) return body;

    const sanitized = { ...body };
    sanitized.messages = body.messages.map(msg => {
      // assistant messages with only tool_calls have content: null — leave as-is
      if (!msg.content) return msg;

      // String content is always fine
      if (typeof msg.content === "string") return msg;

      // Array content: filter/convert unsupported part types
      if (Array.isArray(msg.content)) {
        const cleanContent = msg.content
          .map(part => {
            if (part.type === "text") return part;
            if (part.type === "image_url") return part;
            // Serialize tool_use, tool_result, thinking, etc. as text
            const text = part.text || part.content || JSON.stringify(part);
            return { type: "text", text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          .filter(part => part.text !== ""); // remove empty text parts

        // If all content was stripped (e.g. only tool_result with no text), drop content
        return { ...msg, content: cleanContent.length > 0 ? cleanContent : null };
      }

      return msg;
    });

    return sanitized;
  }

  // Newer OpenAI models (gpt-5+, o1, o3, o4) require max_completion_tokens instead of max_tokens
  requiresMaxCompletionTokens(model) {
    return /gpt-5|o[134]-/i.test(model);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = { ...body };
    if (this.requiresMaxCompletionTokens(model) && transformed.max_tokens !== undefined) {
      transformed.max_completion_tokens = transformed.max_tokens;
      delete transformed.max_tokens;
    }
    // "none" means no thinking — strip it so models that don't support "none" don't 400
    if (transformed.reasoning_effort === "none") {
      delete transformed.reasoning_effort;
    }
    // Config-driven strip of params unsupported by this provider/model
    stripUnsupportedParams("github", model, transformed);
    return transformed;
  }

  // GitHub Copilot's /responses endpoint only serves OpenAI (gpt/codex) models.
  // Gemini and Claude models are not available there and reject with a 400
  // "does not support Responses API" (unsupported_api_for_model). They must
  // therefore never be escalated to /responses, even if /chat/completions
  // returned a "not supported" error for an unrelated reason. Fixes #1062.
  supportsResponsesEndpoint(model) {
    const m = (model || "").toLowerCase();
    return !(m.includes("gemini") || m.includes("claude"));
  }

  prefersResponsesEndpoint(model, catalogModel = null) {
    if (!this.supportsResponsesEndpoint(model)) return false;
    if (catalogModel) return getCopilotModelEndpoint(catalogModel) === "responses";
    return /^gpt-5\.6(?:-|$)/i.test(model || "");
  }

  transformResponsesRequest(model, body, stream, credentials) {
    const transformedBody = openaiToOpenAIResponsesRequest(model, body, stream, credentials);

    if (Array.isArray(transformedBody.tools)) {
      transformedBody.tools = transformedBody.tools.map((tool) => tool?.type === "function"
        ? { ...tool, parameters: normalizeCopilotToolSchema(tool.parameters), strict: true }
        : tool);
    }

    return transformedBody;
  }

  async execute(options) {
    const { model, log, credentials, proxyOptions = null } = options;

    // Claude models: route to Copilot's Anthropic-native /v1/messages shim — the only
    // Copilot endpoint that surfaces prompt-cache token counts for Claude. Detected by
    // model NAME (not a registry field): Copilot's live model catalog regularly exposes
    // claude-* variants the static registry hasn't caught up with yet (see registry/github.js).
    if (this.isClaudeModel(model)) {
      log?.debug("GITHUB", `${model} route=/v1/messages source=model-family`);
      return this.executeWithMessagesEndpoint(options);
    }

    // The live catalog is authoritative for endpoint support. Newer GPT models
    // can advertise both endpoints but return an empty HTTP 200 from chat, so
    // prefer /responses whenever the catalog offers it.
    if (credentials) {
      const catalog = await resolveCopilotModels(credentials, { log, proxyOptions });
      const catalogModel = catalog?.models?.find((entry) => entry.id === model);
      const catalogEndpoints = catalogModel?.supportedEndpoints?.join(",") || "none";
      log?.debug("GITHUB", `${model} catalog=${catalogModel ? "matched" : "missing"} endpoints=${catalogEndpoints}`);
      if (catalogModel && this.prefersResponsesEndpoint(model, catalogModel)) {
        this.knownCodexModels.add(model);
        log?.debug("GITHUB", `${model} route=/responses source=catalog`);
        return this.executeWithResponsesEndpoint(options);
      }
    }

    if (this.prefersResponsesEndpoint(model)) {
      this.knownCodexModels.add(model);
      log?.debug("GITHUB", `${model} route=/responses source=model-family`);
      return this.executeWithResponsesEndpoint(options);
    }

    // Only use /responses for models that are explicitly known to need it (e.g. gpt codex models)
    // and that the /responses endpoint actually serves (excludes Gemini/Claude, see #1062).
    if (this.knownCodexModels.has(model) && this.supportsResponsesEndpoint(model)) {
      log?.debug("GITHUB", `${model} route=/responses source=cache`);
      return this.executeWithResponsesEndpoint(options);
    }

    // Sanitize messages before sending to /chat/completions (gpt/gemini/grok — the
    // endpoint rejects non-text/image_url content parts).
    const sanitizedOptions = {
      ...options,
      body: this.sanitizeMessagesForChatCompletions(options.body)
    };

    log?.debug("GITHUB", `${model} route=/chat/completions source=default`);
    const result = await super.execute({ ...sanitizedOptions, proxyOptions: options.proxyOptions || null });

    // Only escalate to /responses for models that endpoint can actually serve.
    // Gemini/Claude would otherwise loop into a misleading "does not support
    // Responses API" 400 instead of surfacing the real /chat/completions error (#1062).
    if (result.response.status === HTTP_STATUS.BAD_REQUEST && this.supportsResponsesEndpoint(model)) {
      const errorBody = await result.response.clone().text();

      if (errorBody.includes("not accessible via the /chat/completions endpoint") || errorBody.includes("The requested model is not supported")) {
        log?.warn("GITHUB", `Model ${model} requires /responses. Switching...`);
        this.knownCodexModels.add(model);
        return this.executeWithResponsesEndpoint(options);
      }
    }

    return result;
  }

  async executeWithResponsesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = getGitHubCopilotEndpoints(credentials?.providerSpecificData).responsesUrl;
    const headers = this.buildHeaders(credentials, stream);

    const transformedBody = this.transformResponsesRequest(model, body, stream, credentials);

    log?.debug("GITHUB", `${model} POST ${url}`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal
    }, proxyOptions);

    log?.debug("GITHUB", `${model} upstream=${response.status} content-type=${response.headers?.get?.("content-type") || "unknown"}`);

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    const state = initState("openai-responses");
    state.model = model;

    const decoder = new TextDecoder();
    let buffer = "";
    const convertEvent = (parsed, controller) => {
      const converted = openaiResponsesToOpenAIResponse(parsed, state);
      if (converted) {
        controller.enqueue(new TextEncoder().encode(formatSSE(converted, "openai")));
      }
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const parsed = parseSSELine(trimmed);
          if (!parsed) continue;

          if (parsed.done && stream === true) {
            controller.enqueue(new TextEncoder().encode(SSE_DONE));
            continue;
          }

          convertEvent(parsed, controller);
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            convertEvent(parsed, controller);
          }
        }
      }
    });

    if (!response.body) {
      return { response: new Response("", { status: response.status, headers: response.headers }), url, headers, transformedBody };
    }
    const convertedStream = response.body.pipeThrough(transformStream);

    return {
      response: new Response(convertedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      url,
      headers,
      transformedBody
    };
  }

  // Claude models arrive here OpenAI-shape (chatCore.js targets "openai" for github —
  // see the note in execute() above), so we translate to Anthropic-native ourselves.
  // This is what makes prepareClaudeRequest() (translator/formats/claude.js) inject
  // cache_control — /chat/completions never gets there, so it never sees cache tokens.
  async executeWithMessagesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = getGitHubCopilotEndpoints(credentials?.providerSpecificData).messagesUrl;
    const headers = this.buildHeaders(credentials, stream);

    // Force stream:true upstream regardless of client preference, same as
    // executeWithResponsesEndpoint below — chatCore.js's non-streaming handler already
    // knows how to buffer an SSE response into a single JSON reply when the client
    // asked for stream:false.
    const transformedBody = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, body, true, credentials, "github");
    // _toolNameMap is internal bookkeeping (see openai-to-claude.js) — chatCore.js
    // normally strips it before dispatch and threads it into the response state to
    // restore original tool names; we must do the same here, or Anthropic's strict
    // schema rejects the extra field with a 400.
    const toolNameMap = transformedBody._toolNameMap;
    delete transformedBody._toolNameMap;

    log?.debug("GITHUB", `${model} POST ${url}`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal
    }, proxyOptions);

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    const state = initState(FORMATS.CLAUDE);
    state.model = model;
    if (toolNameMap) state.toolNameMap = toolNameMap;

    const decoder = new TextDecoder();
    let buffer = "";

    const emitAll = (controller, chunks) => {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(formatSSE(c, "openai")));
      }
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const parsed = parseSSELine(trimmed);
          if (!parsed) continue;

          if (parsed.done && stream === true) {
            controller.enqueue(new TextEncoder().encode(SSE_DONE));
            continue;
          }

          emitAll(controller, translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, parsed, state));
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            emitAll(controller, translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, parsed, state));
          }
        }
      }
    });

    if (!response.body) {
      return { response: new Response("", { status: response.status, headers: response.headers }), url, headers, transformedBody };
    }
    const convertedStream = response.body.pipeThrough(transformStream);

    return {
      response: new Response(convertedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      url,
      headers,
      transformedBody
    };
  }

  async refreshCopilotToken(githubAccessToken, log, proxyOptions = null, providerSpecificData = {}) {
    try {
      const tokenUrl = getGitHubCopilotEndpoints(providerSpecificData).copilotTokenUrl;
      if (!tokenUrl) return { token: githubAccessToken };
      const response = await proxyAwareFetch(tokenUrl, {
        headers: {
          "Authorization": `token ${githubAccessToken}`,
          "User-Agent": GITHUB_COPILOT.USER_AGENT,
          "Editor-Version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
          "Editor-Plugin-Version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
          "Accept": "application/json",
          "x-github-api-version": GITHUB_COPILOT.API_VERSION
        }
      }, proxyOptions);
      if (!response.ok) {
        const errorText = await response.text();
        log?.error?.("TOKEN", `Copilot token refresh failed: ${response.status} ${errorText}`);
        return null;
      }
      const data = await response.json();
      log?.info?.("TOKEN", "Copilot token refreshed");
      return { token: data.token, expiresAt: data.expires_at };
    } catch (error) {
      log?.error?.("TOKEN", `Copilot refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshGitHubToken(refreshToken, log, proxyOptions = null, providerSpecificData = {}) {
    try {
      const params = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.config.clientId,
      };
      if (this.config.clientSecret) {
        params.client_secret = this.config.clientSecret;
      }

      const response = await proxyAwareFetch(getGitHubCopilotEndpoints(providerSpecificData).tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams(params)
      }, proxyOptions);
      if (!response.ok) return null;
      const tokens = await response.json();
      log?.info?.("TOKEN", "GitHub token refreshed");
      return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
    } catch (error) {
      log?.error?.("TOKEN", `GitHub refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    let copilotResult = await this.refreshCopilotToken(credentials.accessToken, log, proxyOptions, credentials.providerSpecificData);

    if (!copilotResult && credentials.refreshToken) {
      const githubTokens = await this.refreshGitHubToken(credentials.refreshToken, log, proxyOptions, credentials.providerSpecificData);
      if (githubTokens?.accessToken) {
        copilotResult = await this.refreshCopilotToken(githubTokens.accessToken, log, proxyOptions, credentials.providerSpecificData);
        if (copilotResult) {
          return { ...githubTokens, copilotToken: copilotResult.token, copilotTokenExpiresAt: copilotResult.expiresAt };
        }
        return githubTokens;
      }
    }

    if (copilotResult) {
      return { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken, copilotToken: copilotResult.token, copilotTokenExpiresAt: copilotResult.expiresAt };
    }

    return null;
  }

  needsRefresh(credentials) {
    // Always refresh if no copilotToken
    if (!credentials.copilotToken) return true;

    if (credentials.copilotTokenExpiresAt) {
      // Handle both Unix timestamp (seconds) and ISO string
      let expiresAtMs = credentials.copilotTokenExpiresAt;
      if (typeof expiresAtMs === "number" && expiresAtMs < 1e12) {
        expiresAtMs = expiresAtMs * 1000; // Convert seconds to ms
      } else if (typeof expiresAtMs === "string") {
        expiresAtMs = new Date(expiresAtMs).getTime();
      }
      if (expiresAtMs - Date.now() < 5 * 60 * 1000) return true;
    }
    return super.needsRefresh(credentials);
  }
}

export default GithubExecutor;
