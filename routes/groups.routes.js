const router = require("express").Router();
const groups = require("../services/groups.service");
const mutualAid = require("../services/mutualAid.service");
const agencies = require("../services/agencies.service");
const accessSvc = require("../services/access.service");

function toErrorPayload(err) {
  const data = err?.response?.data;
  if (data) return typeof data === "string" ? data : data;
  return err?.message || "Unknown error";
}

router.get("/", async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === "true";
    const all = await groups.getAllGroups({ forceRefresh });
    const authUser = req.authentikUser || null;
    const filtered = accessSvc.filterGroupsForUser(authUser, all);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim();
    if (!rawName) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    if (!access.isGlobalAdmin) {
      const allowedSuffixes = access.allowedAgencySuffixes || [];
      if (!allowedSuffixes.length) {
        return res
          .status(403)
          .json({ error: "You do not have permission to create groups." });
      }

      const allAgencies = agencies.load();
      const allowedPrefixes = allAgencies
        .filter((a) =>
          allowedSuffixes.includes(
            String(a.suffix || "").trim().toLowerCase()
          )
        )
        .map((a) => String(a.groupPrefix || "").trim().toUpperCase())
        .filter(Boolean);

      const upperName = rawName.toUpperCase();
      const canCreateForAny = allowedPrefixes.some((prefix) => {
        // Support both "CPD-GROUP" and "CPD - GROUP"
        return (
          upperName.startsWith(prefix + "-") ||
          upperName.startsWith(prefix + " -")
        );
      });

      if (!canCreateForAny) {
        return res.status(403).json({
          error:
            "You may only create agency-specific groups for your own agency.",
        });
      }
    }

    const description = String(req.body?.description || "").trim() || null;

    const rawGroupType = String(req.body?.groupType || "").trim();
    const groupType =
      rawGroupType === "Agency" || rawGroupType === "County" || rawGroupType === "Global"
        ? rawGroupType
        : "Global";

    const groupTypeDetail = String(req.body?.groupTypeDetail || "").trim() || null;

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const createdAt = new Date().toISOString();

    const attributes = {
      created_at: createdAt,
      created_type: groupType,
      created_type_detail: groupTypeDetail,
    };

    if (description) {
      attributes.description = description;
    }

    if (createdBy) {
      attributes.created_by_username = createdBy.username;
      attributes.created_by_display_name = createdBy.displayName;
    }

    const out = await groups.createGroup(rawName, { attributes });
    res.json({ success: true, group: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * Rename group
 * Expected body: { name: "NEW_GROUP_NAME" }
 */
router.patch("/:groupId", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const out = await groups.renameGroup(req.params.groupId, name);
    res.json({ success: true, group: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Impact preview before delete
router.get("/:groupId/impact", async (req, res) => {
  try {
    const out = await groups.getDeleteImpact(req.params.groupId);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Delete now cleans up users + templates
router.delete("/:groupId", async (req, res) => {
  try {
    const out = await groups.deleteGroupWithCleanup(req.params.groupId);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/mass-assign", async (req, res) => {
  try {
    const out = await groups.massAssignUsersToGroup({
      groupId: req.body?.groupId,
      suffixes: req.body?.suffixes,
      // allow multiple source groups (backwards compatible)
      sourceGroupIds: req.body?.sourceGroupIds ?? req.body?.sourceGroupId,
      userIds: req.body?.userIds,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Mass unassign users from a group
router.post("/mass-unassign", async (req, res) => {
  try {
    const out = await groups.massUnassignUsersFromGroup({
      groupId: req.body?.groupId,
      suffixes: req.body?.suffixes,
      // allow multiple source groups (same semantics as mass-assign)
      sourceGroupIds: req.body?.sourceGroupIds ?? req.body?.sourceGroupId,
      userIds: req.body?.userIds,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Fetch members of a single group, plus related mutual-aid entries
router.get("/:groupId/members", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const group = await groups.getGroupById(groupId);
    const users = await groups.getGroupMembers(groupId);

    let mutual = [];
    try {
      const items = mutualAid.list() || [];
      const groupName = String(group?.name || "").trim();
      mutual = items.filter((it) => {
        const idMatch = String(it.groupId || "") === String(groupId);
        const nameMatch =
          groupName && String(it.groupName || "").trim() === groupName;
        return idMatch || nameMatch;
      });
    } catch (e) {
      mutual = [];
    }

    res.json({
      group,
      users,
      mutualAid: mutual,
      memberCount: Array.isArray(users) ? users.length : 0,
    });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
