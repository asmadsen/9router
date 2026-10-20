/**
 * Regression test for #1062:
 * GitHub Copilot's /responses endpoint only serves OpenAI (gpt/codex) models.
 * Gemini/Claude models must never be routed/escalated there, otherwise they
 * fail with a misleading 400 "does not support Responses API".
 */

import { describe, it, expect, vi } from "vitest";
import { GithubExecutor, normalizeCopilotToolSchema } from "../../open-sse/executors/github.js";

describe("normalizeCopilotToolSchema", () => {
  it("requires all object properties and preserves optionality with null", () => {
    expect(normalizeCopilotToolSchema({
      type: "object",
      properties: {
        path: { type: "string" },
        options: {
          type: "object",
          properties: { depth: { type: "integer" } },
        },
      },
      required: ["path"],
    })).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        options: {
          type: ["object", "null"],
          properties: { depth: { type: ["integer", "null"] } },
          required: ["depth"],
          additionalProperties: false,
        },
      },
      required: ["path", "options"],
      additionalProperties: false,
    });
  });

  it("removes redundant oneOf annotations from enum properties", () => {
    expect(normalizeCopilotToolSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write"],
          oneOf: [
            { const: "read", description: "Read data" },
            { const: "write", description: "Write data" },
          ],
        },
      },
      required: ["action"],
    }).properties.action).toEqual({
      type: "string",
      enum: ["read", "write"],
      description: 'Values: "read": Read data; "write": Write data',
    });
  });

  it("converts const-based oneOf properties to enums", () => {
    expect(normalizeCopilotToolSchema({
      type: "object",
      properties: {
        action: {
          oneOf: [
            { const: "session.create", description: "Create a session" },
            { const: "session.send", description: "Send a prompt" },
          ],
        },
      },
      required: ["action"],
    }).properties.action).toEqual({
      type: "string",
      enum: ["session.create", "session.send"],
      description: 'Values: "session.create": Create a session; "session.send": Send a prompt',
    });
  });

  it("replaces non-const oneOf unions with supported anyOf unions", () => {
    expect(normalizeCopilotToolSchema({
      oneOf: [{ type: "string" }, { type: "number" }],
    })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });
});

describe("GithubExecutor.supportsResponsesEndpoint", () => {
  const exec = new GithubExecutor();

  it("excludes Gemini models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-preview")).toBe(false);
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-low")).toBe(false);
  });

  it("excludes Claude models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("claude-sonnet-4.6")).toBe(false);
    expect(exec.supportsResponsesEndpoint("claude-opus-4.7")).toBe(false);
  });

  it("allows OpenAI/codex models on the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gpt-5.5-codex")).toBe(true);
    expect(exec.supportsResponsesEndpoint("o4-mini")).toBe(true);
    expect(exec.supportsResponsesEndpoint("gpt-4.1")).toBe(true);
  });

  it("is null-safe", () => {
    expect(exec.supportsResponsesEndpoint(undefined)).toBe(true);
    expect(exec.supportsResponsesEndpoint("")).toBe(true);
  });
});

describe("GithubExecutor.prefersResponsesEndpoint", () => {
  const exec = new GithubExecutor();

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "routes %s to /responses without catalog metadata",
    (model) => {
      expect(exec.prefersResponsesEndpoint(model)).toBe(true);
    },
  );

  it("uses catalog metadata for other OpenAI models", () => {
    expect(exec.prefersResponsesEndpoint("gpt-next", {
      supportedEndpoints: ["/chat/completions", "/responses"],
    })).toBe(true);
  });

  it("obeys a catalog entry that only advertises chat completions", () => {
    expect(exec.prefersResponsesEndpoint("gpt-5.6-terra", {
      supportedEndpoints: ["/chat/completions"],
    })).toBe(false);
  });

  it("never routes Claude or Gemini to /responses", () => {
    const catalogModel = { supportedEndpoints: ["/responses"] };
    expect(exec.prefersResponsesEndpoint("claude-opus-4.7", catalogModel)).toBe(false);
    expect(exec.prefersResponsesEndpoint("gemini-3.1-pro-preview", catalogModel)).toBe(false);
  });
});

describe("GithubExecutor GPT 5.6 Responses request", () => {
  it("preserves Chat Completions generation settings", () => {
    const exec = new GithubExecutor();
    const requestBody = exec.transformResponsesRequest("gpt-5.6-terra", {
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 32000,
      reasoning_effort: "medium",
    }, true, {});

    expect(requestBody.max_output_tokens).toBe(32000);
    expect(requestBody.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it("preserves a native Responses API max_output_tokens limit", () => {
    const exec = new GithubExecutor();
    const requestBody = exec.transformResponsesRequest("gpt-5.6-terra", {
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      max_output_tokens: 1024,
    }, true, {});

    expect(requestBody.max_output_tokens).toBe(1024);
  });

});

describe("GithubExecutor enterprise endpoints", () => {
  const exec = new GithubExecutor();
  const credentials = { providerSpecificData: { enterpriseUrl: "company.ghe.com" } };

  it("keeps the public endpoint by default", () => {
    expect(exec.buildUrl("gpt-5.4", true, 0, {})).toBe("https://api.githubcopilot.com/chat/completions");
  });

  it("routes chat completions through the enterprise Copilot API", () => {
    expect(exec.buildUrl("gpt-5.4", true, 0, credentials)).toBe(
      "https://copilot-api.company.ghe.com/chat/completions",
    );
  });
});

describe("GithubExecutor.execute cached-route guard (#1062)", () => {
  it("does NOT use /responses for a Gemini model even if it was wrongly cached as codex", async () => {
    const exec = new GithubExecutor();
    // Simulate a prior misclassification that cached the Gemini model.
    exec.knownCodexModels.add("gemini-3.1-pro-preview");

    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses" });
    // Short-circuit the /chat/completions path (BaseExecutor.execute).
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    const result = await exec.execute({ model: "gemini-3.1-pro-preview", body: { messages: [] }, log: null });

    expect(respSpy).not.toHaveBeenCalled();
    expect(baseSpy).toHaveBeenCalled();
    expect(result.via).toBe("chat");
  });

  it("forces upstream chat streaming for non-streaming clients", async () => {
    const exec = new GithubExecutor();
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    await exec.execute({
      model: "gpt-5.5",
      body: { stream: false, messages: [{ role: "user", content: "Hello" }] },
      stream: false,
      log: null,
    });

    expect(baseSpy).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      body: expect.objectContaining({ stream: true }),
    }));
  });
});
