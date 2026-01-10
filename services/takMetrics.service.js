/**
 * services/takMetrics.service.js
 *
 * Pull operational metrics from TAK Server (custom actuator endpoints + Spring metrics).
 *
 * Reads config from settings.json via services/env.js (settings first, then process.env):
 *   TAK_URL
 *   TAK_DEBUG
 *   TAK_API_P12_PATH / TAK_API_P12_PASSPHRASE   OR   TAK_API_CERT_PATH / TAK_API_KEY_PATH
 *   TAK_CA_PATH
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
  const p12Pass = String(getString("TAK_API_P12_PASSPHRASE", "")); // allow empty

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
    const { getPemFromP12 } = require("p12-pem");
    const certs = getPemFromP12(p12Path, p12Pass);

    if (!certs?.pemCertificate) throw new Error("TAK metrics: Unable to extract certificate(s) from P12");
    if (!certs?.pemKey) throw new Error("TAK metrics: Unable to extract private key from P12");

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

// ---- Custom endpoints (your TAK server) ----

async function getCpuFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-cpu-metrics`);
  if (!data) return null;

  const cpuUsage = pickNumber(data, ["cpuUsage"]);
  const msgUsage = pickNumber(data, ["messagingCpuUsage"]);
  const cpuCount = pickNumber(data, ["cpuCount"]);
  const msgCount = pickNumber(data, ["messagingCpuCount"]);

  return {
    cpuCount: cpuCount ?? null,
    cpuPercent: clampPct(cpuUsage != null ? cpuUsage * 100 : null),
    messagingCpuCount: msgCount ?? null,
    messagingCpuPercent: clampPct(msgUsage != null ? msgUsage * 100 : null),
    raw: data,
  };
}

async function getDiskFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-disk-metrics`);
  if (!data) return null;

  const total = pickNumber(data, ["totalSpace"]);
  const used = pickNumber(data, ["usedSpace"]);
  const free = pickNumber(data, ["freeSpace"]);
  const usable = pickNumber(data, ["usableSpace"]);

  const diskUsagePercent =
    Number.isFinite(used) && Number.isFinite(total) && total > 0
      ? clampPct((used / total) * 100)
      : null;

  return {
    totalSpace: Number.isFinite(total) ? total : null,
    usedSpace: Number.isFinite(used) ? used : null,
    freeSpace: Number.isFinite(free) ? free : null,
    usableSpace: Number.isFinite(usable) ? usable : null,
    diskUsagePercent,
    raw: data,
  };
}

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

async function getNetworkFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-network-metrics`);
  if (!data) return null;

  const numClients = pickNumber(data, ["numClients"]);
  const bytesRead = pickNumber(data, ["bytesRead"]);
  const bytesWritten = pickNumber(data, ["bytesWritten"]);
  const numReads = pickNumber(data, ["numReads"]);
  const numWrites = pickNumber(data, ["numWrites"]);

  return {
    numClients: Number.isFinite(numClients) ? numClients : null,
    bytesRead: Number.isFinite(bytesRead) ? bytesRead : null,
    bytesWritten: Number.isFinite(bytesWritten) ? bytesWritten : null,
    numReads: Number.isFinite(numReads) ? numReads : null,
    numWrites: Number.isFinite(numWrites) ? numWrites : null,
    raw: data,
  };
}

// ---- Spring metric for uptime (works fine) ----

async function getSpringMetricValue(client, actuatorBase, name) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/metrics/${encodeURIComponent(name)}`);
  if (!data || typeof data !== "object") return null;

  if (typeof data.value === "number") return data.value;
  const m = Array.isArray(data.measurements) ? data.measurements : [];
  const first = m.find((x) => x && typeof x.value === "number");
  return first ? first.value : null;
}

async function getUptimeSeconds(client, actuatorBase) {
  const up = await getSpringMetricValue(client, actuatorBase, "process.uptime");
  if (!Number.isFinite(up)) return null;
  return up;
}

// ---- Snapshot ----

async function getTakMetricsSnapshot() {
  const takUrl = getString("TAK_URL", "");
  if (!String(takUrl || "").trim()) {
    return { configured: false, fetchedAt: new Date().toISOString() };
  }

  const base = normalizeBase(takUrl);
  const root = getHostRootFromTakUrl(base);
  const actuatorBase = root;

  const client = buildTakAxios();

  const [cpu, disk, mem, net, uptimeSeconds] = await Promise.all([
    getCpuFromCustomEndpoint(client, actuatorBase).catch(() => null),
    getDiskFromCustomEndpoint(client, actuatorBase).catch(() => null),
    getMemoryFromCustomEndpoint(client, actuatorBase).catch(() => null),
    getNetworkFromCustomEndpoint(client, actuatorBase).catch(() => null),
    getUptimeSeconds(client, actuatorBase).catch(() => null),
  ]);

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

    // Disk usage from your custom endpoint (used/total)
    diskUsagePercent: disk?.diskUsagePercent ?? null,
    disk: disk
      ? {
          totalSpace: disk.totalSpace,
          usedSpace: disk.usedSpace,
          freeSpace: disk.freeSpace,
          usableSpace: disk.usableSpace,
        }
      : null,

    // Memory usage from your custom endpoint (heapUsed/heapCommitted)
    memoryUsagePercent: mem?.heapPercent ?? null,
    memory: mem
      ? {
          heapPercent: mem.heapPercent,
          heapUsed: mem.heapUsed,
          heapCommitted: mem.heapCommitted,
          messagingHeapPercent: mem.messagingHeapPercent,
          messagingHeapUsed: mem.messagingHeapUsed,
          messagingHeapCommitted: mem.messagingHeapCommitted,
        }
      : null,

    // Connected clients from your custom network endpoint
    connectedClients: net?.numClients ?? null,
    network: net
      ? {
          bytesRead: net.bytesRead,
          bytesWritten: net.bytesWritten,
          numReads: net.numReads,
          numWrites: net.numWrites,
        }
      : null,

    uptimeSeconds,
  };
}

module.exports = {
  getTakMetricsSnapshot,
};
