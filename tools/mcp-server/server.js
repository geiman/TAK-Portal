#!/usr/bin/env node
// TAK Portal MCP server (stdio). Lets a local AI agent read user requests from
// emails/spreadsheets and create TAK Portal users, agencies and mutual aid
// through the portal's token API. Configure with:
//   TAK_PORTAL_URL    e.g. https://takportal.example.org
//   TAK_PORTAL_TOKEN  a token from Server Settings > API Tokens (tpk_...)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPortalClient } from "./client.js";
import { readSpreadsheet } from "./sheets.js";

const INSTRUCTIONS = `Tools for creating TAK Portal accounts from user requests (emails, spreadsheets).
Workflow:
1. Call list_agencies to learn agency names, abbreviations and templates.
2. If the request has a spreadsheet, call read_spreadsheet with its path.
3. Map each person to { badge, agency, firstName, lastName, email, template?, radioCallsign?, role? }.
   Use only data that is in the request; never invent badge numbers or emails. Ask the human when unsure.
4. Call validate_users and show the human the preview table and any errors or warnings.
5. Only after the human confirms, call create_users with exactly the validated rows.
Agencies and mutual aid follow the same validate, confirm, create pattern.`;

export const userShape = z.object({
  badge: z.string().describe("Badge / ID number; becomes the username together with the agency token."),
  agency: z.string().describe("Agency suffix, abbreviation, or exact name (see list_agencies)."),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional().describe("Optional; receives the onboarding email when no password is given."),
  password: z.string().optional().describe("Optional; leave out so the user sets one from the onboarding email."),
  template: z.string().optional().describe("Template name; defaults to the agency's default template."),
  radioCallsign: z.string().optional(),
  role: z.string().optional().describe("Optional TAK role override; normally the template's role."),
});

const agencyShape = {
  name: z.string().describe("Full agency name."),
  groupPrefix: z.string().describe("Agency abbreviation / short name, e.g. RCSO."),
  suffix: z.string().describe("Username agency identifier, e.g. rcso."),
  usernameTokenPlacement: z.enum(["suffix", "prefix"]).optional(),
  state: z.string().describe("Two-letter state code, FED or OTHER."),
  stateFederalAgency: z.boolean().optional().describe("true for state/federal agencies (county not required)."),
  county: z.string().optional(),
  countyAbbrev: z.string().optional(),
  type: z.string().optional().describe("Agency type, e.g. Law Enforcement."),
  color: z.string().describe("One of: Blue, Dark Blue, Brown, Cyan, Green, Dark Green, Magenta, Maroon, Orange, Purple, Red, Teal, White, Yellow."),
  regionId: z.string().optional(),
};

function asText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function asError(err) {
  return { isError: true, content: [{ type: "text", text: `Error: ${err?.message || err}` }] };
}

export function buildServer(portal) {
  const server = new McpServer(
    { name: "tak-portal", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );

  const wrap = (fn) => async (args) => {
    try {
      return asText(await fn(args || {}));
    } catch (err) {
      return asError(err);
    }
  };

  server.registerTool(
    "whoami",
    {
      title: "Token info",
      description: "Show which agencies this API token can manage and what it is allowed to create.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => portal.me())
  );

  server.registerTool(
    "list_agencies",
    {
      title: "List agencies",
      description: "List the agencies this token can manage, with abbreviations, username suffixes and user templates.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => portal.listAgencies())
  );

  server.registerTool(
    "search_users",
    {
      title: "Search users",
      description: "Search existing portal users by name, username, email or badge, e.g. to check whether someone already has an account.",
      inputSchema: {
        query: z.string().describe("Search text."),
        agency: z.string().optional().describe("Optional agency suffix to limit the search."),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ query, agency, page }) => portal.searchUsers({ query, agency, page }))
  );

  server.registerTool(
    "read_spreadsheet",
    {
      title: "Read spreadsheet",
      description: "Read a local .xlsx, .csv or .tsv file (for example an email attachment) and return its rows as objects keyed by the header row.",
      inputSchema: {
        path: z.string().describe("Absolute path to the file on this computer."),
        sheet: z.string().optional().describe("Worksheet name; defaults to the first sheet with data."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ path, sheet }) => readSpreadsheet(path, { sheet }))
  );

  server.registerTool(
    "validate_users",
    {
      title: "Validate users (no changes)",
      description: "Check up to 200 users without creating anything. Returns, per row, the username that would be created, groups, warnings, or the reason it would fail (duplicate email, existing username, unknown agency or template, password policy, agency not allowed). Always run this and show the human the results before create_users.",
      inputSchema: { users: z.array(userShape).min(1).max(200) },
      annotations: { readOnlyHint: true },
    },
    wrap(({ users }) => portal.validateUsers(users))
  );

  server.registerTool(
    "create_users",
    {
      title: "Create users",
      description: "Create up to 200 regular TAK Portal users. Each row is validated again and created independently; failed rows are reported and skipped. Only call after validate_users and after the human has confirmed the list.",
      inputSchema: { users: z.array(userShape).min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    wrap(({ users }) => portal.createUsers(users))
  );

  server.registerTool(
    "validate_agency",
    {
      title: "Validate agency (no changes)",
      description: "Check a new agency without creating it (requires a token allowed to create agencies).",
      inputSchema: agencyShape,
      annotations: { readOnlyHint: true },
    },
    wrap((agency) => portal.validateAgency(agency))
  );

  server.registerTool(
    "create_agency",
    {
      title: "Create agency",
      description: "Create a new agency and its Authentik groups. Only call after validate_agency and the human's confirmation. Users can be added once it exists; templates are set up in the portal.",
      inputSchema: agencyShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    wrap((agency) => portal.createAgency(agency))
  );

  server.registerTool(
    "list_mutual_aid",
    {
      title: "List mutual aid",
      description: "List mutual aid entries visible to this token (passwords are not included).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => portal.listMutualAid())
  );

  server.registerTool(
    "create_mutual_aid",
    {
      title: "Create mutual aid",
      description: "Create a mutual aid entry (shared login plus a new MA group). The password is not returned; open the Mutual Aid page in the portal for the packet and QR code. Requires a token allowed to create mutual aid, and the human's confirmation.",
      inputSchema: {
        type: z.enum(["INCIDENT", "EVENT", "STANDBY"]),
        title: z.string().describe("Title, e.g. County Fair 2026."),
        expireEnabled: z.boolean().optional(),
        expireAt: z.string().optional().describe("ISO date/time when the login should expire (required if expireEnabled)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    wrap((item) => portal.createMutualAid(item))
  );

  return server;
}

async function main() {
  const portal = createPortalClient({
    baseUrl: process.env.TAK_PORTAL_URL,
    token: process.env.TAK_PORTAL_TOKEN,
  });
  const server = buildServer(portal);
  await server.connect(new StdioServerTransport());
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/server.js");
if (isMain && !process.env.TAK_PORTAL_MCP_NO_MAIN) {
  main().catch((err) => {
    console.error(`[tak-portal-mcp] ${err?.message || err}`);
    process.exit(1);
  });
}
