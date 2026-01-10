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
 *
 * Optional smoothing config:
 *   TAK_METRICS_SAMPLE_INTERVAL_MS  (default 2000)
 *   TAK_METRICS_WINDOW_SAMPLES      (default 5)
 *   TAK_METRICS_TRIM_SAMPLES        (default 1)  // trims N low + N high when averaging
 *   TAK_METRICS_MAX_SAMPLE_AGE_MS   (default 15000)
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

  // Combined "overall JVM heap usage" (heap + messaging)
  const totalUsed =
    (Number.isFinite(heapUsed) ? heapUsed : 0) +
    (Number.isFinite(msgUsed) ? msgUsed : 0);

  const totalCommitted =
    (Number.isFinite(heapCommitted) ? heapCommitted : 0) +
    (Number.isFinite(msgCommitted) ? msgCommitted : 0);

  const heapPercent =
    Number.isFinite(totalCommitted) && totalCommitted > 0
      ? clampPct((totalUsed / totalCommitted) * 100)
      : null;

  const messagingHeapPercent =
    Number.isFinite(msgUsed) && Number.isFinite(msgCommitted) && msgCommitted > 0
      ? clampPct((msgUsed / msgCommitted) * 100)
      : null;

  return {
    heapCommitted: Number.isFinite(heapCommitted) ? heapCommitted : null,
    heapUsed: Number.isFinite(heapUsed) ? heapUsed : null,
    heapPercent, // combined overall percent
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

// ---- Spring metric for uptime ----

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

// ---------------------------
// Smoothing / Sampling Buffer
// ---------------------------

const SAMPLE_INTERVAL_MS = Number(process.env.TAK_METRICS_SAMPLE_INTERVAL_MS ?? 2000);
const WINDOW_SAMPLES = Math.max(1, Number(process.env.TAK_METRICS_WINDOW_SAMPLES ?? 5));
const TRIM_SAMPLES = Math.max(0, Number(process.env.TAK_METRICS_TRIM_SAMPLES ?? 1));
const MAX_SAMPLE_AGE_MS = Math.max(1000, Number(process.env.TAK_METRICS_MAX_SAMPLE_AGE_MS ?? 15000));

let _samplerStarted = false;
let _sampleTimer = null;

/** Each sample: { ts, cpu, mem, disk, net, uptimeSeconds } */
let _samples = [];

function pushSample(s) {
  _samples.push(s);
  // keep buffer bounded
  const maxKeep = Math.max(WINDOW_SAMPLES * 3, WINDOW_SAMPLES + 2);
  if (_samples.length > maxKeep) {
    _samples.splice(0, _samples.length - maxKeep);
  }
}

function isFreshEnough() {
  const last = _samples[_samples.length - 1];
  if (!last) return false;
  return Date.now() - last.ts <= MAX_SAMPLE_AGE_MS;
}

function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  return sum / v.length;
}

/**
 * Robust average: sort, trim low/high outliers, then mean.
 * If trimming would remove everything, falls back to simple mean.
 */
function trimmedMean(values, trimEachSide) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (trimEachSide <= 0) return mean(v);

  const start = trimEachSide;
  const end = v.length - trimEachSide;
  if (end <= start) return mean(v);

  return mean(v.slice(start, end));
}

function takeWindowSamples() {
  const now = Date.now();
  // Only consider relatively recent samples (avoid averaging across a long downtime)
  const recent = _samples.filter((s) => now - s.ts <= MAX_SAMPLE_AGE_MS);
  if (!recent.length) return [];

  // Take last WINDOW_SAMPLES
  return recent.slice(Math.max(0, recent.length - WINDOW_SAMPLES));
}

function startSamplerIfNeeded({ client, actuatorBase }) {
  if (_samplerStarted) return;
  _samplerStarted = true;

  const tick = async () => {
    try {
      const [cpu, disk, mem, net, uptimeSeconds] = await Promise.all([
        getCpuFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getDiskFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getMemoryFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getNetworkFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getUptimeSeconds(client, actuatorBase).catch(() => null),
      ]);

      pushSample({
        ts: Date.now(),
        cpu,
        mem,
        disk,
        net,
        uptimeSeconds,
      });
    } catch {
      // swallow; next tick will try again
    }
  };

  // Prime immediately (don’t wait for first interval)
  void tick();

  _sampleTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
  // don't keep node alive solely for this timer
  if (typeof _sampleTimer.unref === "function") _sampleTimer.unref();
}

function buildSmoothedFromWindow(window) {
  // CPU smoothing
  const cpuPercents = window.map((s) => s.cpu?.cpuPercent).filter((x) => Number.isFinite(x));
  const msgCpuPercents = window.map((s) => s.cpu?.messagingCpuPercent).filter((x) => Number.isFinite(x));

  const cpuPercentSmoothed = clampPct(trimmedMean(cpuPercents, TRIM_SAMPLES));
  const messagingCpuPercentSmoothed = clampPct(trimmedMean(msgCpuPercents, TRIM_SAMPLES));

  // Memory smoothing (combined heapPercent is already computed in endpoint function)
  const heapPercents = window.map((s) => s.mem?.heapPercent).filter((x) => Number.isFinite(x));
  const msgHeapPercents = window.map((s) => s.mem?.messagingHeapPercent).filter((x) => Number.isFinite(x));

  const heapPercentSmoothed = clampPct(trimmedMean(heapPercents, TRIM_SAMPLES));
  const messagingHeapPercentSmoothed = clampPct(trimmedMean(msgHeapPercents, TRIM_SAMPLES));

  return {
    cpuPercentSmoothed,
    messagingCpuPercentSmoothed,
    heapPercentSmoothed,
    messagingHeapPercentSmoothed,
  };
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

  // Start background sampler (collects samples even if snapshot isn't called often)
  startSamplerIfNeeded({ client, actuatorBase });

  // If we have no fresh sample, do a one-off immediate fetch to avoid returning nulls
  if (!isFreshEnough()) {
    try {
      const [cpu, disk, mem, net, uptimeSeconds] = await Promise.all([
        getCpuFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getDiskFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getMemoryFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getNetworkFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getUptimeSeconds(client, actuatorBase).catch(() => null),
      ]);
      pushSample({ ts: Date.now(), cpu, mem, disk, net, uptimeSeconds });
    } catch {
      // ignore
    }
  }

  const window = takeWindowSamples();
  const latest = window[window.length - 1] || _samples[_samples.length - 1] || null;

  const smoothed = buildSmoothedFromWindow(window);

  // Prefer smoothed values when available; otherwise fall back to latest raw
  const cpuOut = latest?.cpu
    ? {
        cpuCount: latest.cpu.cpuCount,
        cpuPercent: smoothed.cpuPercentSmoothed ?? latest.cpu.cpuPercent ?? null,
        messagingCpuCount: latest.cpu.messagingCpuCount,
        messagingCpuPercent: smoothed.messagingCpuPercentSmoothed ?? latest.cpu.messagingCpuPercent ?? null,
      }
    : null;

  const memOut = latest?.mem
    ? {
        heapPercent: smoothed.heapPercentSmoothed ?? latest.mem.heapPercent ?? null,
        heapUsed: latest.mem.heapUsed,
        heapCommitted: latest.mem.heapCommitted,
        messagingHeapPercent: smoothed.messagingHeapPercentSmoothed ?? latest.mem.messagingHeapPercent ?? null,
        messagingHeapUsed: latest.mem.messagingHeapUsed,
        messagingHeapCommitted: latest.mem.messagingHeapCommitted,
      }
    : null;

  // Disk/network/uptime: keep latest (you can smooth these too, but usually not needed)
  const diskOut = latest?.disk
    ? {
        totalSpace: latest.disk.totalSpace,
        usedSpace: latest.disk.usedSpace,
        freeSpace: latest.disk.freeSpace,
        usableSpace: latest.disk.usableSpace,
      }
    : null;

  const netOut = latest?.net
    ? {
        bytesRead: latest.net.bytesRead,
        bytesWritten: latest.net.bytesWritten,
        numReads: latest.net.numReads,
        numWrites: latest.net.numWrites,
      }
    : null;

  return {
    configured: true,
    fetchedAt: new Date().toISOString(),

    // Optional: expose how many samples were used
    sampleWindow: {
      intervalMs: SAMPLE_INTERVAL_MS,
      windowSamples: window.length,
      trimSamples: TRIM_SAMPLES,
      maxSampleAgeMs: MAX_SAMPLE_AGE_MS,
    },

    cpu: cpuOut,

    diskUsagePercent: latest?.disk?.diskUsagePercent ?? null,
    disk: diskOut,

    memoryUsagePercent: memOut?.heapPercent ?? null,
    memory: memOut,

    connectedClients: latest?.net?.numClients ?? null,
    network: netOut,

    uptimeSeconds: latest?.uptimeSeconds ?? null,
  };
}

module.exports = {
  getTakMetricsSnapshot,
};
