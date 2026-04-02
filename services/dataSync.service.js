/**
 * services/dataSync.service.js — TAK Server Marti mission / Data Sync API (mTLS via tak.service buildTakAxios).
 * See: https://docs.opentakserver.io/marti_api.html
 */

const { buildTakAxios, isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");

function assertTakAvailable() {
  if (getBool("TAK_BYPASS_ENABLED", false)) {
    const e = new Error("TAK operations are disabled (TAK_BYPASS_ENABLED=true).");
    e.code = "TAK_BYPASS";
    throw e;
  }
  if (!isTakConfigured()) {
    const e = new Error("TAK_URL is not configured in Server Settings.");
    e.code = "TAK_NOT_CONFIGURED";
    throw e;
  }
}

function missionPath(missionName) {
  const n = String(missionName || "").trim();
  if (!n) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  return `/api/missions/${encodeURIComponent(n)}`;
}

async function listPagedMissions(params) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get("/api/pagedmissions", { params: params || {} });
  return res.data;
}

async function getMission(missionName) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get(missionPath(missionName));
  return res.data;
}

async function putMission(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.put(missionPath(missionName), body, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

async function postMission(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.post(missionPath(missionName), body, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

async function deleteMission(missionName) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.delete(missionPath(missionName));
  return res.data;
}

async function setMissionPassword(missionName, password) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 30000 });
  const res = await client.put(`${missionPath(missionName)}/password`, String(password ?? ""), {
    headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "application/json" },
  });
  return res.data;
}

async function clearMissionPassword(missionName) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 30000 });
  const res = await client.delete(`${missionPath(missionName)}/password`);
  return res.data;
}

async function listGroupsAll() {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get("/api/groups/all");
  return res.data;
}

async function putMissionKeywords(missionName, keywordsPayload) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 30000 });
  const res = await client.put(`${missionPath(missionName)}/keywords`, keywordsPayload, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

/**
 * PUT /api/missions/:name/contents — associate uploaded content with a mission.
 */
async function putMissionContents(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 120000 });
  const res = await client.put(`${missionPath(missionName)}/contents`, body, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

async function getSyncSearch(params) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get("/sync/search", { params: params || {} });
  return res.data;
}

const KML_MIME = "application/vnd.google-earth.kml+xml";

/**
 * Full mission / data sync package as KML — TAK Marti GET /ExportMissionKML (parameter names vary by build).
 * @param {string} missionName
 * @param {Record<string, string>} queryParams - e.g. { password: "..." } for protected missions
 */
async function exportMissionKmlStream(missionName, queryParams = {}) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 180000 });
  const name = String(missionName || "").trim();
  if (!name) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  const base = { ...queryParams };

  const attempts = [
    { path: "/ExportMissionKML", params: { ...base, mission: name } },
    { path: "/ExportMissionKML", params: { ...base, missionName: name } },
    { path: "/ExportMissionKML", params: { ...base, name: name } },
    { path: `/ExportMissionKML/${encodeURIComponent(name)}`, params: { ...base } },
  ];

  let lastRes = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const res = await client.get(a.path, {
      params: a.params,
      responseType: "stream",
      validateStatus: () => true,
    });
    lastRes = res;
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status !== 404) return res;
  }
  return lastRes;
}

module.exports = {
  assertTakAvailable,
  missionPath,
  listPagedMissions,
  getMission,
  putMission,
  postMission,
  deleteMission,
  setMissionPassword,
  clearMissionPassword,
  listGroupsAll,
  putMissionKeywords,
  putMissionContents,
  getSyncSearch,
  exportMissionKmlStream,
  KML_MIME,
};
