const router = require("express").Router();
const store = require("../services/agencies.service");
const accessSvc = require("../services/access.service");
const usersService = require("../services/users.service");
const groupsService = require("../services/groups.service");
const api = require("../services/authentik");

function getAgencyAdminGroupName(groupPrefix) {
  const abbr = String(groupPrefix || "").trim().toUpperCase();
  if (!abbr) return null;
  return `authentik-${abbr}-AgencyAdmin`;
}

async function ensureAgencyAdminGroupExists(agency) {
  const name = getAgencyAdminGroupName(agency?.groupPrefix);
  if (!name) throw new Error("Agency abbreviation (groupPrefix) is required");

  // Create (idempotent-ish): if the group already exists, Authentik will reject.
  // We treat "already exists" as success.
  const attributes = {
    created_at: new Date().toISOString(),
    created_type: "Agency",
    created_type_detail: String(agency?.name || agency?.groupPrefix || "").trim() || null,
    description: `Agency admin group for ${String(agency?.name || agency?.groupPrefix || "").trim()}`,
  };

  try {
    await groupsService.createGroup(name, { attributes });
    return { created: true, name };
  } catch (err) {
    const msg = String(err?.response?.data?.detail || err?.response?.data || err?.message || "");
    // Common Authentik duplicate patterns include "unique" / "already exists".
    const lower = msg.toLowerCase();
    if (lower.includes("already") || lower.includes("exists") || lower.includes("unique")) {
      return { created: false, name };
    }
    throw err;
  }
}

// IMPORTANT:
// The portal intentionally hides internal Authentik groups from /api/groups
// (via GROUPS_HIDDEN_PREFIXES, often including "authentik-").
// Agencies need to look up their computed admin group anyway.
// So, for the agencies page ONLY, we query Authentik directly to resolve
// a group by name (unfiltered).
async function getGroupByNameUnfiltered(groupName) {
  const name = String(groupName || "").trim();
  if (!name) throw new Error("Group name is required");

  // 1) Try exact-name filter (fast if supported)
  try {
    const res = await api.get(`/core/groups/?name=${encodeURIComponent(name)}`);
    const results = Array.isArray(res?.data?.results) ? res.data.results : [];
    const exact = results.find(g => String(g?.name || "").trim().toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  } catch (e) {
    // ignore and fall back to search
  }

  // 2) Fallback: use search and then exact-match in JS
  const res2 = await api.get(`/core/groups/?search=${encodeURIComponent(name)}`);
  const results2 = Array.isArray(res2?.data?.results) ? res2.data.results : [];
  const exact2 = results2.find(g => String(g?.name || "").trim().toLowerCase() === name.toLowerCase());
  return exact2 || null;
}

function normalizeAgency(a) {
  return {
    name: String(a.name || "").trim(),
    type: String(a.type || "").trim(),            // Fire, EMS, Law, etc
    county: String(a.county || "").trim(),
    suffix: String(a.suffix || "").trim().toLowerCase(),
    groupPrefix: String(a.groupPrefix || "").trim().toUpperCase(),
    color: String(a.color || "").trim(),
  };
}

function validateAgency(a) {
  if (!a.name) return "Name is required";
  if (!a.suffix) return "Username suffix is required";
  if (!a.groupPrefix) return "Group prefix is required";
  if (!a.color) return "Agency color is required";
  return null;
}

// Basic agencies list (raw)
router.get("/", (req, res) => {
  const agencies = store.load();
  const filtered = accessSvc.filterAgenciesForUser(req.authentikUser, agencies);
  res.json(filtered);
});

// Agencies (no user counts anymore)
router.get("/with-counts", async (req, res) => {
  try {
    const agencies = store.load();
    const visible = accessSvc.filterAgenciesForUser(req.authentikUser, agencies);

    const result = visible.map((a, index) => {
      const id = index;
      return { ...a, id, _id: id };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Resolve the computed admin group for an agency, even if the group is hidden from /api/groups.
// Returns: { group: { pk, name, ... } }
router.get("/:index/admin-group", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });

    const a = agencies[idx];
    const groupName = getAgencyAdminGroupName(a?.groupPrefix);
    if (!groupName) return res.status(400).json({ error: "Agency abbreviation is missing" });

    const g = await getGroupByNameUnfiltered(groupName);
    if (!g) return res.status(404).json({ error: `Admin group \"${groupName}\" was not found in Authentik.` });

    return res.json({ group: g });
  } catch (err) {
    return res.status(500).json({ error: err?.response?.data || err?.message || "Failed to resolve admin group" });
  }
});

router.post("/", async (req, res) => {
  const agencies = store.load();
  const a = normalizeAgency(req.body || {});

  const err = validateAgency(a);
  if (err) return res.status(400).json({ error: err });

  if (agencies.some(x => String(x.suffix || "").toLowerCase() === a.suffix)) {
    return res.status(400).json({ error: "Suffix already exists" });
  }

  try {
    // Ensure the agency admin group exists in Authentik.
    await ensureAgencyAdminGroupExists(a);
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to create agency admin group",
    });
  }

  agencies.push(a);
  store.save(agencies);
  res.json({ success: true });
});

router.put("/:index", async (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });

  const a = normalizeAgency(req.body || {});
  const err = validateAgency(a);
  if (err) return res.status(400).json({ error: err });

  // uniqueness check excluding itself
  if (agencies.some((x, i) =>
    i !== idx && String(x.suffix || "").toLowerCase() === a.suffix
  )) {
    return res.status(400).json({ error: "Suffix already exists" });
  }

  try {
    // If the abbreviation changed (or group is missing), create the new admin group.
    await ensureAgencyAdminGroupExists(a);
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to ensure agency admin group",
    });
  }

  agencies[idx] = a;
  store.save(agencies);
  res.json({ success: true });
});

router.delete("/:index", (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });

  agencies.splice(idx, 1);
  store.save(agencies);
  res.json({ success: true });
});

module.exports = router;
