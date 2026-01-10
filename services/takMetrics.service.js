/**
 * services/takMetrics.service.js
 *
 * Pull operational metrics from TAK Server (Spring Boot actuator / Marti metrics).
 *
 * Env or settings.json (services/env.js reads settings first, then process.env):
 *   TAK_URL                       e.g. https://tak.example.com:8443 or https://tak.example.com:8443/Marti
 *   TAK_DEBUG=true                (optional)
 *
 * Mutual TLS (choose ONE):
 *   TAK_API_P12_PATH              PKCS#12 client cert (P12/PFX)
 *   TAK_API_P12_PASSPHRASE        (optional, may be empty)
 *
 *   TAK_API_CERT_PATH             PEM client cert
 *   TAK_API_KEY_PATH              PEM private key
 *   TAK_API_KEY_PASSPHRASE        (optional)
 *
 * Optional:
 *   TAK_CA_PATH                   PEM CA bundle
 *   TAK_CONNECTED_CLIENTS_PATH    Full path starting with "/" (ex: /Marti/api/metrics/connectedClients)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");
const { URL } = require("url");
const { getBool, getString } = require("./env");

function resolvePathMaybe(p) {
  const v = String(p || "").trim();
  if (!v) return "";
  if (path.isAbsolute(v)) return v;
  return path.resolve(process.cwd(), v);
}

function normalizeBase(urlLike) {
  const raw = String(urlLike || "").trim();
  if (!raw) return "";
  const u = new URL(raw);
  // strip trailing slashes
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString().replace(/\/+$/, "");
}

function getHostRootFromTakUrl(takUrl) {
  // If TAK_URL is https://host:8443/Marti, actuator lives at https://host:8443
  const u = new URL(String(takUrl || "").trim());
  u.pathname = "";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

function normalizePemCertificateChain(pemCertificate) {
  return String(pemCertificate)
    .replace(/\r\n/g, "\n")
    .split("-----BEGIN CERTIFICATE-----")
    .join("-----BEGIN CERTIFICATE-----\n")
    .split("-----END CERTIFICATE-----")
    .join("\n-----END CERTIFICATE-----")
    .trim();
}

function normalizePemKey(pemKey) {
  let key = String(pemKey).replace(/\r\n/g, "\n").trim();

  if (key.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    key = key
      .split("-----BEGIN RSA PRIVATE KEY-----")
      .join("-----BEGIN RSA PRIVATE KEY-----\n")
      .split("-----END RSA PRIVATE KEY-----")
      .join("\n-----END RSA PRIVATE KEY-----")
      .trim();
  }

  if (key.includes("-----BEGIN PRIVATE KEY-----")) {
    key = key
      .split("-----BEGIN PRIVATE KEY-----")
      .join("-----BEGIN PRIVATE KEY-----\n")
      .split("-----END PRIVATE KEY-----")
      .join("\n-----END PRIVATE KEY-----")
      .trim();
  }

  return key;
}

function buildTakAxios() {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);

  const p12Path = resolvePathMaybe(getString("TAK_API_P12_PATH", ""));
  // IMPORTANT: use getString() so settings.json works (not process.env directly)
  // Allow empty string passphrase (common for P12)
  const p12Pass = String(getString("TAK_API_P12_PASSPHRASE", ""));

  const certPath = resolvePathMaybe(getString("TAK_API_CERT_PATH", ""));
  const keyPath = resolvePathMaybe(getString("TAK_API_KEY_PATH", ""));
  const keyPass = getString("TAK_API_KEY_PASSPHRASE", "")
    ? String(getString("TAK_API_KEY_PASSPHRASE", ""))
    : undefined;

  const caPath = resolvePathMaybe(getString("TAK_CA_PATH", ""));

  const agentOptions = {
    ca: caPath ? fs.readFileSync(caPath) : undefined,
    rejectUnauthorized: true,
    // keep previous behavior (skip hostname verification)
    checkServerIdentity: () => undefined,
  };

  if (p12Path) {
    // Parse PKCS#12 (incl RC2-40-CBC) -> PEM using p12-pem
    const { getPemFromP12 } = require("p12-pem");
    const certs = getPemFromP12(p12Path, p12Pass);

    if (!certs?.pemCertificate) {
      throw new Error("TAK metrics: Unable to extract certificate(s) from P12");
    }
    if (!certs?.pemKey) {
      throw new Error("TAK metrics: Unable to extract private key from P12");
    }

    agentOptions.cert = normalizePemCertificateChain(certs.pemCertificate);
    agentOptions.key = normalizePemKey(certs.pemKey);
  } else if (certPath && keyPath) {
    agentOptions.cert = fs.readFileSync(certPath);
    agentOptions.key = fs.readFileSync(keyPath);
    if (keyPass) agentOptions.passphrase = keyPass;
  }

  const httpsAgent = new https.Agent(agentOptions);

  const client = axios.create({
    httpsAgent,
    timeout: 10_000,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 500,
  });

  if (TAK_DEBUG) {
    client.interceptors.request.use((cfg) => {
      // eslint-disable-next-line no-console
      console.log("[TAK][metrics] ->", cfg.method?.toUpperCase(), cfg.url);
      return cfg;
    });
    client.interceptors.response.use((res) => {
      // eslint-disable-next-line no-console
      console.log("[TAK][metrics] <-", res.status, res.config?.url);
      return res;
    });
  }

  return client;
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function clampPct(x) {
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

async function safeGetJson(client, url) {
  const res = await client.get(url, { headers: { Accept: "application/json" } });
  if (res.status >= 200 && res.status < 300) return res.data;
  return null;
}

async function getCpuFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-cpu-metrics`);
  if (!data) return null;

  // { cpuCount, cpuUsage (0..1), messagingCpuUsage (0..1), messagingCpuCount }
  const cpuUsage = pickNumber(data, ["cpuUsage", "usage", "cpu"]);
  const msgUsage = pickNumber(data, ["messagingCpuUsage", "messagingUsage"]);
  const cpuCount = pickNumber(data, ["cpuCount", "processors"]);
  const msgCount = pickNumber(data, ["messagingCpuCount"]);

  return {
    cpuCount: cpuCount ?? null,
    cpuPercent: clampPct(cpuUsage != null ? cpuUsage * 100 : null),
    messagingCpuCount: msgCount ?? null,
    messagingCpuPercent: clampPct(msgUsage != null ? msgUsage * 100 : null),
    raw: data,
  };
}

/**
 * Custom memory endpoint:
 *   GET /actuator/custom-memory-metrics
 *
 * Sample:
 * {
 *   "heapCommitted":1.04333312E9,
 *   "heapUsed":5.43270664E8,
 *   "messagingHeapCommitted":5.24288E8,
 *   "messagingHeapUsed":4.45533456E8
 * }
 *
 * We compute percent as Used / Committed (committed is what JVM has reserved).
 */
async function getMemoryFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-memory-metrics`);
  if (!data) return null;

  const heapCommitted = pickNumber(data, ["heapCommitted"]);
  const heapUsed = pickNumber(data, ["heapUsed"]);
  const msgCommitted = pickNumber(data, ["messagingHeapCommitted"]);
  const msgUsed = pickNumber(data, ["messagingHeapUsed"]);

  const heapPercent =
    Number.isFinite(heapUsed) && Number.isFinite(heapCommitted) && heapCommitted > 0
      ? clampPct((heapUsed / heapCommitted) * 100)
      : null;

  const messagingHeapPercent =
    Number.isFinite(msgUsed) && Number.isFinite(msgCommitted) && msgCommitted > 0
      ? clampPct((msgUsed / msgCommitted) * 100)
      : null;

  return {
    heapCommitted: Number.isFinite(heapCommitted) ? heapCommitted : null,
    heapUsed: Number.isFinite(heapUsed) ? heapUsed : null,
    heapPercent,
    messagingHeapCommitted: Number.isFinite(msgCommitted) ? msgCommitted : null,
    messagingHeapUsed: Number.isFinite(msgUsed) ? msgUsed : null,
    messagingHeapPercent,
    raw: data,
  };
}

async function getSpringMetricValue(client, actuatorBase, name) {
  // Spring Actuator metric format: { name, measurements:[{statistic,value}], availableTags:[] }
  const data = await safeGetJson(client, `${actuatorBase}/actuator/metrics/${encodeURIComponent(name)}`);
  if (!data || typeof data !== "object") return null;

  if (typeof data.value === "number") return data.value;
  const m = Array.isArray(data.measurements) ? data.measurements : [];
  const first = m.find((x) => x && typeof x.value === "number");
  return first ? first.value : null;
}

async function getDiskUsagePercent(client, actuatorBase) {
  const free = await getSpringMetricValue(client, actuatorBase, "disk.free");
  const total = await getSpringMetricValue(client, actuatorBase, "disk.total");
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
  return clampPct((1 - free / total) * 100);
}

async function getUptimeSeconds(client, actuatorBase) {
  const up = await getSpringMetricValue(client, actuatorBase, "process.uptime");
  if (!Number.isFinite(up)) return null;
  return up;
}

async function getConnectedClients(client, takUrl) {
  const override = String(getString("TAK_CONNECTED_CLIENTS_PATH", "")).trim();
  const base = normalizeBase(takUrl);
  if (!base) return null;

  // If an explicit path is provided, trust it.
  if (override && override.startsWith("/")) {
    const data = await safeGetJson(client, `${getHostRootFromTakUrl(base)}${override}`);
    const n = typeof data === "number" ? data : pickNumber(data, ["connectedClients", "clientCount", "count", "value"]);
    return Number.isFinite(n) ? n : null;
  }

  // Otherwise try a couple common patterns (best-effort; may be null)
  const candidates = [
    "/Marti/api/metrics/connectedClients",
    "/Marti/api/metrics/clientCount",
    "/Marti/api/metrics/clients",
  ];

  for (const p of candidates) {
    const data = await safeGetJson(client, `${getHostRootFromTakUrl(base)}${p}`);
    const n = typeof data === "number" ? data : pickNumber(data, ["connectedClients", "clientCount", "count", "value"]);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

async function getTakMetricsSnapshot() {
  const takUrl = getString("TAK_URL", "");
  if (!String(takUrl || "").trim()) {
    return { configured: false, fetchedAt: new Date().toISOString() };
  }

  const base = normalizeBase(takUrl);
  const root = getHostRootFromTakUrl(base);
  const actuatorBase = root;

  const client = buildTakAxios();

  const [cpu, diskPct, memCustom, uptimeSeconds, connectedClients] = await Promise.all([
    getCpuFromCustomEndpoint(client, actuatorBase).catch(() => null),
    getDiskUsagePercent(client, actuatorBase).catch(() => null),
    getMemoryFromCustomEndpoint(client, actuatorBase).catch(() => null),
    getUptimeSeconds(client, actuatorBase).catch(() => null),
    getConnectedClients(client, base).catch(() => null),
  ]);

  // Preserve the existing memoryUsagePercent field so your dashboard keeps working,
  // but now it is based on custom heap metrics (Used/Committed).
  const memoryUsagePercent = memCustom?.heapPercent ?? null;

  return {
    configured: true,
    fetchedAt: new Date().toISOString(),
    cpu: cpu
      ? {
          cpuCount: cpu.cpuCount,
          cpuPercent: cpu.cpuPercent,
          messagingCpuCount: cpu.messagingCpuCount,
          messagingCpuPercent: cpu.messagingCpuPercent,
        }
      : null,
    diskUsagePercent: diskPct,
    memoryUsagePercent,
    // Extra detail (optional for later UI)
    memory: memCustom
      ? {
          heapPercent: memCustom.heapPercent,
          heapUsed: memCustom.heapUsed,
          heapCommitted: memCustom.heapCommitted,
          messagingHeapPercent: memCustom.messagingHeapPercent,
          messagingHeapUsed: memCustom.messagingHeapUsed,
          messagingHeapCommitted: memCustom.messagingHeapCommitted,
        }
      : null,
    connectedClients,
    uptimeSeconds,
  };
}

module.exports = {
  getTakMetricsSnapshot,
};
