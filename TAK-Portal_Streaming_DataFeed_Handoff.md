# Feature Handoff: Streaming Data Feed Provisioning via TAK Portal

**Objective**: Extend the existing "Create Integration" workflow in TAK Portal to automatically construct a corresponding "Streaming Data Feed" inside the upstream TAK Server, while providing a decoupled architecture allowing retroactive configuration.

## 1. Overview
When an administrator creates a new Integration user, they frequently need a streaming data feed bound to that integration. This modification introduces an intermediate modal structure that captures streaming data feed metrics. It additionally grants administrators the choice to skip the prompt, decouple the creation process, and visually observe mapped Integrations directly in the portal dashboard via new Red/Green table toggles. 

## 2. Modified Files
- `views/integrations.ejs`
- `routes/integrations.routes.js`
- `services/users.service.js`

---

## 3. Frontend Implementation Details (`views/integrations.ejs`)

### Modal Markup & Decoupled User Experience
- The `createForm` logic intercepts the payload instead of immediately dispatching. 
- A designated "Make Streaming Data Feed? [Yes/No]" dropdown governs the initial context. If `No`, the Integration pushes cleanly with a `skipDataFeed: true` boolean payload.
- If `Yes`, a secondary modal (`dataFeedModalOverlay`) sliders over mimicking TAK Server's configuration options:
  - `Data Feed Name` (Disabled; strictly bound to the auto-generated Integration User Name e.g. `nodered-[type]-[name]` to prevent naming collisions)
  - `Tags` (Newline-separated block)
  - `Protocol` (Dropdown)
  - `Authentication Type` (Dropdown)
  - `Port` (Integer) - includes a reminder note to open firewall rules.
  - `Core Messaging Version` & Checkboxes for discrete mapping of `TLSv1, TLSv1.1, TLSv1.2, TLSv1.3`.
  - `Multicast Group`, `Interface`, `Sync Cache Retention`, `Archive`, `Anonymous Group`, `Archive Only`, `Sync`, `Federated`.

### Group Filtering & Dynamic Render States
- The modal organically populates a dynamically scrolling checkbox list corresponding to `groupsCache` (Authentik Groups).
- Visually checking the box belonging to the Group initialized in Step 1 minimizes redundant workflow steps.
- **Table Visual Indicators**:
   - The Integration Table renders `dataFeedName` via Red `<button>` bindings if unmapped (`No DF`) or Green bindings if active (`DF Enabled`).
   - The Red button enables a retroactive "create" flow sending users to configuring a feed after the fact.
   - The Green button implements a `GET` proxy proxy query rendering the data in purely read-only to show how it's structurally formatted on TAK Server explicitly.

---

## 4. Backend Implementation Details (`routes/integrations.routes.js` & `services/users.service.js`)

### Storage Hooks & Authentik API Patching
- `services/users.service.js` includes an exported `updateUserAttributes()` utility designed to `api.patch()` into `attributes: {...}` (utilizing strictly raw JSON to prevent mapping rejection by Authentik). 
- When an administrator provisions a Data Feed initially, the UI successfully constructs the object on TAK Server and then immediately saves the `tak_data_feed_name` onto the Authentik object metadata. This guarantees safe binding and prevents messy proxy queries based strictly on Titles.

### Payload Deconstruction
- `POST /api/integrations`: The body now parses `skipDataFeed` logic to bypass cleanly. The API dynamically infers `dataFeedName` directly from the generated user payload output instead of trusting frontend nomenclature, providing strict 1:1 binding parity.
- `GET /api/integrations`: Correctly parses out `.attributes.tak_data_feed_name` distributing the UI boolean to power the Red/Green table.

### Retroactive API Endpoints
- **`GET /api/integrations/:username/datafeed`**: Proxies requests securely to `takClient.get("/api/datafeeds/{dataFeedName}")` resolving the TAK XML/JAXB model precisely.
- **`POST /api/integrations/:username/datafeed`**: Decoupled initialization hook resolving the `takSvc.post` to reconstruct a newly generated feed out-of-band using the path `username`.

### Non-Fatal Data Feed Handling
- Currently, the initial API flow implements a "Graceful Decay" error model.
- If `/api/datafeeds` encounters a 4xx/5xx failure (e.g., misconfigured TLS version, or TAK Node syncing issues), it drops the failure reason into `dataFeedError`.
- It *does not* kill or roll-back the overall `createIntegration` payload. Rather, it surfaces `dataFeedError` within the `res.json` body.

---

## 5. Aspects for Code Optimization & Developer Review
If you decide to accept, tweak, or optimize these concepts, please consider the following contexts:

1. **Transaction State / Deletions**: The deletion sequence (`DELETE /api/integrations/:userId`) automatically hooks into Authentik to pull the mapped `tak_data_feed_name`, securely querying `takSvc` to permanently cascade and delete the streaming data feed *prior* to wiping the Integration Account. This guarantees orphan profiles do not clutter the TAK Server schema. If creation endpoints drop...
2. **TAK Node Clusters (CoreConfig)**: `POST /api/datafeeds` in clustered environments depends upon Ignite clustering propagation. The current flow waits for HTTP 200 sequentially. If your environments experience heavy node delays, injecting standard timeout/retry architectures here could be beneficial.
3. **Internal `takSvc` Axios Context**: The payload is using `takSvc.buildTakAxios()`. Feel free to review its Base URL handling regarding `/Marti` context roots to ensure maximum compatibility with user configurations leveraging standalone endpoints versus proxies.
