const settingsSvc = require("./settings.service");

/**
 * Built-in agency types (order fixed). "Other" is always last in the dropdown.
 * Additional types from settings are inserted immediately before "Other".
 */
const CORE_AGENCY_TYPES = [
  "Law Enforcement",
  "Fire",
  "EMS",
  "State Defense",
  "Military",
  "Game Warden / NPS / Forestry",
  "CBRNE / HAZMAT",
  "SAR / Technical",
  "Emergency Management",
  "Dispatch / Communications",
  "Public Works",
  "Volunteer",
];

const MAX_ADDITIONAL_AGENCY_TYPES = 30;

function getAdditionalAgencyTypesFromSettings(settings) {
  const s = settings || {};
  const out = [];
  for (let i = 1; i <= MAX_ADDITIONAL_AGENCY_TYPES; i += 1) {
    const v = String(s[`ADDITIONAL_AGENCY_TYPE_${i}`] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * Full ordered list for the Agencies page type dropdown:
 * core types, then additional (deduped, order preserved), then Other.
 */
function getAgencyTypeOptions(settings) {
  const s = settings != null ? settings : settingsSvc.getSettings() || {};
  const extras = getAdditionalAgencyTypesFromSettings(s);
  const coreLower = new Set(CORE_AGENCY_TYPES.map((x) => x.toLowerCase()));
  const seen = new Set();
  const dedupedExtras = [];
  for (const e of extras) {
    const k = e.toLowerCase();
    if (coreLower.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    dedupedExtras.push(e);
  }
  return [...CORE_AGENCY_TYPES, ...dedupedExtras, "Other"];
}

module.exports = {
  CORE_AGENCY_TYPES,
  MAX_ADDITIONAL_AGENCY_TYPES,
  getAgencyTypeOptions,
  getAdditionalAgencyTypesFromSettings,
};
