require("dotenv").config();
const express = require("express");
const path = require("path");

const mutualAidSvc = require("./services/mutualAid.service");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// API Routes
app.use("/api/agencies", require("./routes/agencies.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/groups", require("./routes/groups.routes"));
app.use("/api/templates", require("./routes/templates.routes"));
app.use("/api/qr", require("./routes/qr.routes"));
app.use("/api/mutual-aid", require("./routes/mutualAid.routes"));
app.use("/", require("./routes/dashboard.routes"));


// UI Routes
app.get("/", (req, res) => res.redirect("/users/create"));
app.get("/users/create", (req, res) => res.render("users-create"));
app.get("/users/manage", (req, res) => res.render("users-manage"));
app.get("/groups", (req, res) => res.render("groups"));
app.get("/agencies", (req, res) => res.render("agencies"));
app.get("/templates", (req, res) => res.render("templates"));
app.get("/mutual-aid", (req, res) => res.render("mutual-aid"));
app.get("/qr-generator", (req, res) => res.render("qr-generator"));


const port = process.env.WEB_UI_PORT || 3000;
app.listen(port, () => {
  console.log(`✅ TAK Authentik Web Admin running on http://localhost:${port}`);

  // Rehydrate expiration timers from stored mutual aid records.
  try {
    mutualAidSvc.initExpirationScheduler();
  } catch (e) {
    console.log("⚠️ Mutual aid expiration scheduler init failed", e?.message || e);
  }

  try {
    const takUrl = process.env.TAK_URL;
    if (!takUrl) {
      console.log("⚠️ TAK_URL not set in .env");
      return;
    }

    const host = new URL(takUrl).hostname;
    console.log("TAK host:", host);
  } catch (e) {
    console.log("⚠️ Invalid TAK_URL in .env");
  }
});


