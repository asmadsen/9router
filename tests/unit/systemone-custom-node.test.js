import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { sanitizeSystemoneBaseUrl } from "@/shared/utils/systemoneUrl";
import { isSystemoneCompatibleProvider } from "@/shared/constants/providers";

describe("custom System One node", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sanitizes base url", () => {
    expect(sanitizeSystemoneBaseUrl(" https://gw.example/v1/ ")).toBe("https://gw.example/v1");
    expect(sanitizeSystemoneBaseUrl("https://gw.example/v1/systemone")).toBe("https://gw.example/v1");
  });

  it("detects prefix", () => {
    expect(isSystemoneCompatibleProvider("systemone-compatible-abc")).toBe(true);
    expect(isSystemoneCompatibleProvider("v1m")).toBe(false);
  });

  it("forwards body to <baseUrl>/systemone with bearer and raw model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { state: "hi", model: "x", questions: { q: { type: "noul", instructions: "?" } } };
    const res = await handleSystemoneCore({
      body,
      modelInfo: { provider: "systemone-compatible-abc", model: "microsoft-decision-1" },
      credentials: { apiKey: "tok", providerSpecificData: { baseUrl: "https://gw.example/v1" } },
    });
    expect(res.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).model).toBe("microsoft-decision-1");
  });
});
