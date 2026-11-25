// Minimal client for the TAK Portal token API (/api/v1).

export class PortalError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createPortalClient({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!root) throw new Error("TAK_PORTAL_URL is not set (for example https://takportal.example.org).");
  if (!/^https?:\/\//i.test(root)) throw new Error("TAK_PORTAL_URL must start with https:// or http://");
  if (!String(token || "").startsWith("tpk_")) {
    throw new Error("TAK_PORTAL_TOKEN is not set or is not a TAK Portal API token (tpk_...).");
  }

  async function call(method, path, body) {
    const res = await fetchImpl(`${root}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (res.status >= 300 && res.status < 400) {
      throw new PortalError(
        `The portal redirected the request (HTTP ${res.status}). The reverse proxy is probably sending /api/v1 through Authentik login; see docs/API-AND-MCP.md.`,
        res.status
      );
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new PortalError(String(msg), res.status);
    }
    if (data === null) {
      throw new PortalError("The portal returned a non-JSON response; check TAK_PORTAL_URL and the proxy setup.", res.status);
    }
    return data;
  }

  return {
    me: () => call("GET", "/me"),
    listAgencies: () => call("GET", "/agencies"),
    agencyTemplates: (agency) => call("GET", `/agencies/${encodeURIComponent(agency)}/templates`),
    searchUsers: ({ query = "", agency = "", page = 1, pageSize = 25 } = {}) => {
      const qs = new URLSearchParams({ q: query, page: String(page), pageSize: String(pageSize) });
      if (agency) qs.set("agencySuffix", agency);
      return call("GET", `/users/search?${qs}`);
    },
    validateUsers: (users) => call("POST", "/users/validate", { users }),
    createUsers: (users) => call("POST", "/users", { users }),
    validateAgency: (agency) => call("POST", "/agencies/validate", agency),
    createAgency: (agency) => call("POST", "/agencies", agency),
    listMutualAid: () => call("GET", "/mutual-aid"),
    createMutualAid: (item) => call("POST", "/mutual-aid", item),
  };
}
