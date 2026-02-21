const crypto = require("crypto");
const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");
const store = require("./userRequests.store");
const emailSvc = require("./email.service");
const settingsSvc = require("./settings.service");
const authentik = require("./authentik");

function genId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback for older Node versions
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeStr(v) {
  return String(v || "").trim();
}

function validateCreate(input) {
  const firstName = normalizeStr(input.firstName);
  const lastName = normalizeStr(input.lastName);
  const email = normalizeEmail(input.email);
  const badgeNumber = normalizeStr(input.badgeNumber);
  const agencySuffix = normalizeStr(input.agencySuffix);
  const otherAgency = normalizeStr(input.otherAgency);
  const otherReason = normalizeStr(input.otherReason);

  if (!firstName) throw new Error("First Name is required");
  if (!lastName) throw new Error("Last Name is required");
  if (!email) throw new Error("Email Address is required");
  // Simple sanity check; not a full RFC validator
  if (!/^\S+@\S+\.[A-Za-z]{2,}$/.test(email)) {
    throw new Error("Email Address must be valid");
  }
  if (!badgeNumber) throw new Error("Badge Number is required");
  if (!agencySuffix) throw new Error("Agency is required");

  const isOther = agencySuffix === "__other__";
  if (isOther) {
    if (!otherAgency) {
      throw new Error("Please enter your agency name");
    }
    if (!otherReason) {
      throw new Error("Please enter your reason for requesting access");
    }
  }

  // If they selected a known agency, validate it exists.
  if (!isOther) {
    const agencies = agenciesStore.load();
    const ok = agencies.some(
      (a) => String(a?.suffix || "").toLowerCase() === agencySuffix.toLowerCase()
    );
    if (!ok) throw new Error("Selected agency is not valid");
  }

  return { firstName, lastName, email, badgeNumber, agencySuffix, otherAgency, otherReason };
}

function listRequests() {
  const all = store.load();
  // Newest first
  return all
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function listRequestsForUser(authUser) {
  const user = authUser || null;
  // Global admins can see everything.
  if (user && user.isGlobalAdmin) return listRequests();

  // Agency admins can see only their own agency requests.
  if (user && user.isAgencyAdmin) {
    const allowed = listRequests().filter((r) =>
      accessSvc.isSuffixAllowed(user, r && r.agencySuffix)
    );
    return allowed;
  }

  // Everyone else sees nothing.
  return [];
}

function countRequestsForUser(authUser) {
  return listRequestsForUser(authUser).length;
}


async function createRequest(input) {
  const v = validateCreate(input || {});
  const agencies = agenciesStore.load();
  const agency = agencies.find(
    (a) => String(a?.suffix || "").toLowerCase() === v.agencySuffix.toLowerCase()
  );

  const now = new Date().toISOString();
  const reqObj = {
    id: genId(),
    createdAt: now,
    firstName: v.firstName,
    lastName: v.lastName,
    email: v.email,
    badgeNumber: v.badgeNumber,
    agencySuffix: v.agencySuffix,
    agencyName: agency ? String(agency.name || "").trim() : null,
    otherAgency: v.agencySuffix === "__other__" ? v.otherAgency : null,
    otherReason: v.agencySuffix === "__other__" ? v.otherReason : null,
  };

  const all = store.load();
  all.push(reqObj);
  store.save(all);

  // === Email Notification Logic ===
  try {
    let recipients = [];

    if (v.agencySuffix !== "__other__" && agency) {
      const accessSvc = require("./access.service");
      const groupName = accessSvc.getAgencyAdminGroupName(agency);

      if (groupName) {
        const groupResp = await authentik.get(
          `/core/groups/?name=${encodeURIComponent(groupName)}`
        );

        const group = groupResp.data?.results?.[0];

        if (group) {
          const usersResp = await authentik.get(
            `/core/groups/${group.pk}/users/`
          );

          recipients = (usersResp.data?.results || [])
            .map((u) => u.email)
            .filter(Boolean);
        }
      }
    }

    // Fallback to global admins if none found
    if (!recipients.length) {
      const settings = settingsSvc.getSettings();
      const globalGroup = settings.PORTAL_AUTH_REQUIRED_GROUP;

      if (globalGroup) {
        const groupResp = await authentik.get(
          `/core/groups/?name=${encodeURIComponent(globalGroup)}`
        );

        const group = groupResp.data?.results?.[0];

        if (group) {
          const usersResp = await authentik.get(
            `/core/groups/${group.pk}/users/`
          );

          recipients = (usersResp.data?.results || [])
            .map((u) => u.email)
            .filter(Boolean);
        }
      }
    }

    if (recipients.length) {
      await emailSvc.sendMail({
        to: recipients.join(","),
        subject: "New TAK Portal Access Request",
        text: `A new user has requested access:

Name: ${reqObj.firstName} ${reqObj.lastName}
Email: ${reqObj.email}
Badge: ${reqObj.badgeNumber}
Agency: ${reqObj.agencyName || reqObj.otherAgency || reqObj.agencySuffix}
`,
      });
    }
  } catch (err) {
    console.error("Failed to send access request notification:", err);
  }

  return reqObj;
}



function deleteRequestForUser(id, authUser) {
  const user = authUser || null;
  if (user && user.isGlobalAdmin) return deleteRequest(id);

  // Agency admins can delete only requests in agencies they manage.
  if (user && user.isAgencyAdmin) {
    const reqObj = getById(id);
    if (!reqObj) return false;
    if (!accessSvc.isSuffixAllowed(user, reqObj.agencySuffix)) return false;
    return deleteRequest(id);
  }

  return false;
}

function deleteRequest(id) {
  const rid = String(id || "").trim();
  if (!rid) return false;
  const all = store.load();
  const next = all.filter((r) => String(r.id || "") !== rid);
  const changed = next.length !== all.length;
  if (changed) store.save(next);
  return changed;
}

function getById(id) {
  const rid = String(id || "").trim();
  if (!rid) return null;
  const all = store.load();
  return all.find((r) => String(r.id || "") === rid) || null;
}

module.exports = {
  listRequests,
  listRequestsForUser,
  countRequestsForUser,
  createRequest,
  deleteRequest,
  deleteRequestForUser,
  getById,
};
