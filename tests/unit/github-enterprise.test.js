import { describe, expect, it } from "vitest";
import {
  getGitHubCopilotEndpoints,
  normalizeGitHubEnterpriseUrl,
} from "../../open-sse/config/githubCopilot.js";
import { expandCopilotCatalog, getCopilotModelEndpoint } from "../../open-sse/services/copilotModels.js";
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

  it("normalizes a URL and derives enterprise endpoints", () => {
    expect(getGitHubCopilotEndpoints({ enterpriseUrl: "https://Company.GHE.com/" })).toMatchObject({
      enterpriseUrl: "company.ghe.com",
      deviceCodeUrl: "https://company.ghe.com/login/device/code",
      tokenUrl: "https://company.ghe.com/login/oauth/access_token",
      userInfoUrl: "https://company.ghe.com/api/v3/user",
      copilotTokenUrl: null,
      usageUrl: null,
      modelsUrl: "https://copilot-api.company.ghe.com/models",
      chatCompletionsUrl: "https://copilot-api.company.ghe.com/chat/completions",
      responsesUrl: "https://copilot-api.company.ghe.com/responses",
      messagesUrl: "https://copilot-api.company.ghe.com/v1/messages",
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
