const PUBLIC_COPILOT_BASE_URL = "https://api.githubcopilot.com";
const PUBLIC_GITHUB_BASE_URL = "https://github.com";
const PUBLIC_GITHUB_API_URL = "https://api.github.com";

export function normalizeGitHubEnterpriseUrl(value) {
  if (!value) return null;

  let url;
  try {
    url = new URL(String(value).includes("://") ? String(value) : `https://${value}`);
  } catch {
    throw new Error("Invalid GitHub Enterprise URL or domain");
  }

  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("GitHub Enterprise URL must be a valid HTTPS domain");
  }
  if (url.port || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("GitHub Enterprise URL must not include a port, path, query, or fragment");
  }

  return url.hostname.toLowerCase();
}

export function getGitHubCopilotEndpoints(providerSpecificData = {}) {
  const enterpriseUrl = normalizeGitHubEnterpriseUrl(providerSpecificData.enterpriseUrl);
  const isEnterpriseCloud = enterpriseUrl?.endsWith(".ghe.com") === true;
  const githubBaseUrl = enterpriseUrl ? `https://${enterpriseUrl}` : PUBLIC_GITHUB_BASE_URL;
  const githubApiUrl = isEnterpriseCloud
    ? `https://api.${enterpriseUrl}`
    : enterpriseUrl
      ? `${githubBaseUrl}/api/v3`
      : PUBLIC_GITHUB_API_URL;
  const copilotBaseUrl = enterpriseUrl
    ? `https://copilot-api.${enterpriseUrl}`
    : PUBLIC_COPILOT_BASE_URL;

  return {
    enterpriseUrl,
    deviceCodeUrl: `${githubBaseUrl}/login/device/code`,
    tokenUrl: `${githubBaseUrl}/login/oauth/access_token`,
    userInfoUrl: `${githubApiUrl}/user`,
    copilotTokenUrl: enterpriseUrl ? null : `${githubApiUrl}/copilot_internal/v2/token`,
    usageUrl: enterpriseUrl && !isEnterpriseCloud ? null : `${githubApiUrl}/copilot_internal/user`,
    modelsUrl: `${copilotBaseUrl}/models`,
    chatCompletionsUrl: `${copilotBaseUrl}/chat/completions`,
    responsesUrl: `${copilotBaseUrl}/responses`,
    messagesUrl: `${copilotBaseUrl}/v1/messages`,
  };
}
