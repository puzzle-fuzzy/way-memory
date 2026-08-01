import { resolve4 } from "node:dns/promises";

type JsonRecord = Record<string, unknown>;

const configuredBaseUrl = Bun.env.WAY_MEMORY_PUBLIC_BASE_URL ?? "https://way-memory.yxswy.com";
const requireAuthenticatedWebSocket = ["1", "true", "yes"].includes((Bun.env.WAY_MEMORY_REQUIRE_AUTH ?? "").toLowerCase());
const dashboardToken = Bun.env.WAY_MEMORY_DASHBOARD_TOKEN?.trim();

const fail = (message: string): never => {
  throw new Error(message);
};

const base = (() => {
  let parsed: URL;
  try {
    parsed = new URL(configuredBaseUrl);
  } catch {
    return fail(`invalid public base URL: ${configuredBaseUrl}`);
  }
  if (parsed.protocol !== "https:") return fail("public TLS preflight requires an https:// base URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return fail("public base URL must not contain credentials, query, or fragment");
  if (/^[0-9.]+$/.test(parsed.hostname) || parsed.hostname.includes(":")) return fail("public TLS preflight requires a DNS hostname, not an IP literal");
  return parsed.origin;
})();

const httpBase = base.replace(/^https:/, "http:");
const wsBase = base.replace(/^https:/, "wss:");
const publicHostname = new URL(base).hostname;

const fetchJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${base}${path}`, { ...init, redirect: "manual", cache: "no-store" });
  let body: JsonRecord | undefined;
  try {
    body = await response.json() as JsonRecord;
  } catch {
    body = undefined;
  }
  return { response, body };
};

const waitForOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("authenticated WSS open timeout")), 8_000);
  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("authenticated WSS open failed"));
  }, { once: true });
});

const checkHttpRedirect = async () => {
  const response = await fetch(`${httpBase}/api/health`, { redirect: "manual", cache: "no-store" });
  if (![301, 302, 307, 308].includes(response.status)) {
    fail(`HTTP endpoint must redirect to HTTPS, got ${response.status}`);
  }
  const location = response.headers.get("location");
  if (!location || new URL(location, httpBase).protocol !== "https:") {
    fail("HTTP endpoint redirect does not target HTTPS");
  }
  return response.status;
};

const checkDns = async () => {
  const addresses = await resolve4(publicHostname).catch(() => [] as string[]);
  const expectedAddress = Bun.env.WAY_MEMORY_EXPECTED_PUBLIC_IP?.trim();
  if (!addresses.length) {
    if (expectedAddress) fail(`DNS lookup returned no A record for ${publicHostname}; expected ${expectedAddress}`);
    console.warn(`DNS lookup returned no A record for ${publicHostname}; continuing to the HTTP edge checks`);
    return addresses;
  }
  if (expectedAddress && !addresses.includes(expectedAddress)) {
    fail(`DNS A record mismatch for ${publicHostname}: expected ${expectedAddress}, got ${addresses.join(", ")}`);
  }
  console.log("Public DNS A records", { hostname: publicHostname, addresses });
  return addresses;
};

const run = async () => {
  const dnsAddresses = await checkDns();
  const redirectStatus = await checkHttpRedirect();
  const web = await fetch(`${base}/`, { redirect: "manual", cache: "no-store" });
  if (web.status !== 200 || !(web.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    fail(`HTTPS web entry point failed: HTTP ${web.status}`);
  }

  const health = await fetchJson("/api/health");
  if (health.response.status !== 200 || health.body?.ok !== true) {
    fail(`HTTPS API health failed: HTTP ${health.response.status}`);
  }

  const unauthorizedRealtime = await fetch(`${base}/realtime?role=dashboard&deviceId=public-tls-preflight`, {
    redirect: "manual",
    cache: "no-store",
  });
  if (unauthorizedRealtime.status !== 401) {
    fail(`unauthenticated realtime probe must return 401 in production, got ${unauthorizedRealtime.status}`);
  }

  let authenticatedWs = "skipped";
  if (dashboardToken) {
    const ticket = await fetchJson("/api/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    const value = typeof ticket.body?.ticket === "string" ? ticket.body.ticket : "";
    if (ticket.response.status !== 200 || !value) fail(`authenticated WebSocket ticket failed: HTTP ${ticket.response.status}`);
    const socket = new WebSocket(`${wsBase}/realtime?role=dashboard&deviceId=public-tls-preflight&ticket=${encodeURIComponent(value)}`);
    try {
      await waitForOpen(socket);
      authenticatedWs = "passed";
    } finally {
      socket.close(1000, "TLS preflight complete");
    }
  } else if (requireAuthenticatedWebSocket) {
    fail("WAY_MEMORY_DASHBOARD_TOKEN is required when WAY_MEMORY_REQUIRE_AUTH is enabled");
  }

  console.log("Public TLS preflight passed", {
    base,
    dnsA: dnsAddresses,
    httpRedirect: redirectStatus,
    httpsWeb: 200,
    httpsHealth: 200,
    unauthenticatedRealtime: 401,
    authenticatedWs,
  });
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
