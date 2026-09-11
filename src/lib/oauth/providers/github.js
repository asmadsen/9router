import { GITHUB_CONFIG } from "../constants/oauth.js";
import { getGitHubCopilotEndpoints, normalizeGitHubEnterpriseUrl } from "open-sse/config/githubCopilot.js";

function resolveConfig(config, enterpriseUrl) {
  const endpoints = getGitHubCopilotEndpoints({ enterpriseUrl });
  return {
    ...config,
    enterpriseUrl: endpoints.enterpriseUrl,
    deviceCodeUrl: endpoints.deviceCodeUrl,
    tokenUrl: endpoints.tokenUrl,
    userInfoUrl: endpoints.userInfoUrl,
    copilotTokenUrl: endpoints.copilotTokenUrl,
  };
}

const github = {
  config: GITHUB_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config, codeChallenge, options = {}) => {
    config = resolveConfig(config, options.enterpriseUrl);
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: config.scopes,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Device code request failed: ${error}`);
    }

    const data = await response.json();
    return config.enterpriseUrl ? { ...data, _enterpriseUrl: config.enterpriseUrl } : data;
  },
  pollToken: async (config, deviceCode, codeVerifier, extraData = {}) => {
    config = resolveConfig(config, extraData._enterpriseUrl);
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    // Handle response properly - if not ok, try to get error as text first
    let data;
    try {
      data = await response.json();
    } catch (e) {
      // If response is not JSON, get as text
      const text = await response.text();
      data = { error: "invalid_response", error_description: text };
    }

    return {
      ok: response.ok,
      data: data,
    };
  },
  postExchange: async (tokens, extraData = {}) => {
    const config = resolveConfig(GITHUB_CONFIG, extraData._enterpriseUrl);
    // Get Copilot token using GitHub access token
    const copilotRes = config.copilotTokenUrl ? await fetch(config.copilotTokenUrl, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        "User-Agent": GITHUB_CONFIG.userAgent,
      },
    }) : null;
    const copilotToken = copilotRes?.ok
      ? await copilotRes.json()
      : config.enterpriseUrl
        ? { token: tokens.access_token }
        : {};

    // Get user info from GitHub
    const userRes = await fetch(config.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        "User-Agent": GITHUB_CONFIG.userAgent,
      },
    });
    const userInfo = userRes.ok ? await userRes.json() : {};

    return { copilotToken, userInfo, enterpriseUrl: config.enterpriseUrl };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    name: extra?.userInfo?.login || extra?.userInfo?.name,
    displayName: extra?.userInfo?.name || extra?.userInfo?.login,
    email: extra?.userInfo?.email || null,
    providerSpecificData: {
      copilotToken: extra?.copilotToken?.token,
      copilotTokenExpiresAt: extra?.copilotToken?.expires_at,
      githubUserId: extra?.userInfo?.id,
      githubLogin: extra?.userInfo?.login,
      githubName: extra?.userInfo?.name,
      githubEmail: extra?.userInfo?.email,
      ...(extra?.enterpriseUrl ? { enterpriseUrl: normalizeGitHubEnterpriseUrl(extra.enterpriseUrl) } : {}),
    },
  }),
};

export default github;
