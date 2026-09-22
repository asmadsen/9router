import { describe, expect, it } from "vitest";
import {
  getGitHubCopilotEndpoints,
  normalizeGitHubEnterpriseUrl,
} from "../../open-sse/config/githubCopilot.js";
import { expandCopilotCatalog, getCopilotModelEndpoint } from "../../open-sse/services/copilotModels.js";
import { formatGitHubUsage } from "../../open-sse/services/usage/github.js";
import { buildGitHubTestUrl } from "../../src/app/api/providers/[id]/test/testUtils.js";

describe("GitHub Enterprise Copilot endpoints", () => {
  it("preserves GitHub.com defaults", () => {
    expect(getGitHubCopilotEndpoints()).toMatchObject({
      enterpriseUrl: null,
      deviceCodeUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
      modelsUrl: "https://api.githubcopilot.com/models",
      chatCompletionsUrl: "https://api.githubcopilot.com/chat/completions",
      responsesUrl: "https://api.githubcopilot.com/responses",
      messagesUrl: "https://api.githubcopilot.com/v1/messages",
    });
  });

  it("normalizes a URL and derives self-hosted enterprise endpoints", () => {
    expect(getGitHubCopilotEndpoints({ enterpriseUrl: "https://GitHub.Company.com/" })).toMatchObject({
      enterpriseUrl: "github.company.com",
      deviceCodeUrl: "https://github.company.com/login/device/code",
      tokenUrl: "https://github.company.com/login/oauth/access_token",
      userInfoUrl: "https://github.company.com/api/v3/user",
      copilotTokenUrl: null,
      usageUrl: null,
      modelsUrl: "https://copilot-api.github.company.com/models",
      chatCompletionsUrl: "https://copilot-api.github.company.com/chat/completions",
      responsesUrl: "https://copilot-api.github.company.com/responses",
      messagesUrl: "https://copilot-api.github.company.com/v1/messages",
    });
  });

  it("uses the dedicated API host for GHE.com data residency", () => {
    expect(getGitHubCopilotEndpoints({ enterpriseUrl: "dnb.ghe.com" })).toMatchObject({
      userInfoUrl: "https://api.dnb.ghe.com/user",
      usageUrl: "https://api.dnb.ghe.com/copilot_internal/user",
      modelsUrl: "https://copilot-api.dnb.ghe.com/models",
    });
  });

  it("rejects unsafe or ambiguous values", () => {
    expect(() => normalizeGitHubEnterpriseUrl("http://company.ghe.com")).toThrow(/HTTPS/);
    expect(() => normalizeGitHubEnterpriseUrl("company.ghe.com/path")).toThrow(/path/);
    expect(() => normalizeGitHubEnterpriseUrl("company.ghe.com:8443")).toThrow(/port/);
  });
});

describe("GitHub Enterprise Copilot model catalog", () => {
  it("supports newer catalogs without capabilities.type", () => {
    expect(expandCopilotCatalog([{
      id: "gpt-enterprise",
      name: "GPT Enterprise",
      model_picker_enabled: true,
      policy: { state: "enabled" },
      capabilities: {
        limits: { max_prompt_tokens: 1000, max_output_tokens: 200 },
        supports: { tool_calls: true },
      },
    }])).toEqual([expect.objectContaining({
      id: "gpt-enterprise",
      contextLength: 1000,
      maxOutputTokens: 200,
      capabilities: expect.objectContaining({ contextWindow: 1000, maxOutput: 200, tools: true }),
    })]);
  });

  it("excludes hidden, disabled, and explicitly non-chat models", () => {
    const models = expandCopilotCatalog([
      { id: "visible", model_picker_enabled: true, capabilities: {} },
      { id: "hidden", model_picker_enabled: false, capabilities: {} },
      { id: "disabled", model_picker_enabled: true, policy: { state: "disabled" }, capabilities: {} },
      { id: "embedding", model_picker_enabled: true, capabilities: { type: "embeddings" } },
    ]);
    expect(models.map((model) => model.id)).toEqual(["visible"]);
  });

  it("prefers the Responses API when advertised", () => {
    expect(getCopilotModelEndpoint({ supportedEndpoints: ["/responses", "ws:/responses"] })).toBe("responses");
    expect(getCopilotModelEndpoint({ id: "gpt-5.6-terra", supportedEndpoints: ["/chat/completions", "/responses"] })).toBe("responses");
    expect(getCopilotModelEndpoint({ supportedEndpoints: ["/v1/messages"] })).toBe("messages");
  });
});

describe("GitHub Enterprise Copilot quota", () => {
  it("derives usage from percent_remaining and the UTC reset date", () => {
    expect(formatGitHubUsage({
      copilot_plan: "enterprise",
      quota_reset_date_utc: "2026-10-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          credits_used: 5003,
          entitlement: 150000,
          percent_remaining: 96.6,
          remaining: 144996,
        },
      },
    })).toEqual({
      plan: "enterprise",
      resetDate: "2026-10-01T00:00:00Z",
      quotas: {
        premium_interactions: {
          used: 5003,
          total: 150000,
          remaining: 144996,
          unlimited: false,
          resetAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });
  });

  it("treats limited_user_quotas as remaining allowance", () => {
    expect(formatGitHubUsage({
      access_type_sku: "free_limited_copilot",
      limited_user_reset_date: "2026-10-01",
      monthly_quotas: { chat: 50 },
      limited_user_quotas: { chat: 20 },
    }).quotas.chat).toMatchObject({ used: 30, total: 50, remaining: 20 });
  });

  it("recognizes the -1 entitlement sentinel as unlimited", () => {
    expect(formatGitHubUsage({
      quota_snapshots: { chat: { entitlement: -1, percent_remaining: 100 } },
    }).quotas.chat).toMatchObject({ used: 0, total: 0, remaining: 0, unlimited: true });
  });
});

describe("GitHub Enterprise connection test", () => {
  it("uses the public Copilot models endpoint by default", () => {
    expect(buildGitHubTestUrl()).toBe("https://api.githubcopilot.com/models");
  });

  it("uses the enterprise Copilot models endpoint", () => {
    expect(buildGitHubTestUrl({
      providerSpecificData: { enterpriseUrl: "company.ghe.com" },
    })).toBe("https://copilot-api.company.ghe.com/models");
  });
});
