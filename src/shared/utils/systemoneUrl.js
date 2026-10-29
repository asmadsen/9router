// Strip trailing slash and /systemone so the runtime can append the path once
export function sanitizeSystemoneBaseUrl(baseUrl) {
  let url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (url.endsWith("/systemone")) url = url.slice(0, -"/systemone".length);
  return url;
}
