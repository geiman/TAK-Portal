const router = require("express").Router();
const store = require("../services/agencies.service");
const accessSvc = require("../services/access.service");
const usersService = require("../services/users.service");

function normalizeAgency(a) {
  return {
    name: String(a.name || "").trim(),
    type: String(a.type || "").trim(),            // Fire, EMS, Law, etc
    county: String(a.county || "").trim(),
    suffix: String(a.suffix || "").trim().toLowerCase(),
    groupPrefix: String(a.groupPrefix || "").trim().toUpperCase(),
    color: String(a.color || "").trim(),
    // Comma/semicolon separated list of Authentik groups that
    // should be treated as admins for this agency.
    adminGroups: String(a.adminGroups || "").trim(),
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

router.post("/", (req, res) => {
  const agencies = store.load();
  const a = normalizeAgency(req.body || {});

  const err = validateAgency(a);
  if (err) return res.status(400).json({ error: err });

  if (agencies.some(x => String(x.suffix || "").toLowerCase() === a.suffix)) {
    return res.status(400).json({ error: "Suffix already exists" });
  }

  agencies.push(a);
  store.save(agencies);
  res.json({ success: true });
});

router.put("/:index", (req, res) => {
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
