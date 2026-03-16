(function () {
  function $(id) {
    return document.getElementById(id);
  }

  var state = {
    isGlobalAdmin: false,
    mode: "agency",
  };

  // Caches mirroring the patterns used on Groups / Mutual Aid pages
  var agenciesCache = [];
  var groupsCache = [];

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".segBtn[data-mode]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
    });
    var agencyPane = $("#emailAgencyPane");
    var groupsPane = $("#emailGroupsPane");
    var usersPane = $("#emailUsersPane");
    var allPane = $("#emailAllPane");
    if (agencyPane) agencyPane.style.display = mode === "agency" ? "" : "none";
    if (groupsPane) groupsPane.style.display = mode === "groups" ? "" : "none";
    if (usersPane) usersPane.style.display = mode === "users" ? "" : "none";
    if (allPane) allPane.style.display = mode === "all" ? "" : "none";
  }

  function renderAgencies() {
    var host = $("#emailAgencyList");
    if (!host) return;
    var qEl = $("#emailAgencySearch");
    var needle = qEl ? String(qEl.value || "").trim().toLowerCase() : "";

    // mirror agencyItems()/renderAgencyList() from groups.ejs
    var items = (Array.isArray(agenciesCache) ? agenciesCache : [])
      .filter(function (a) {
        return String(a.suffix || "").trim();
      })
      .slice()
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""));
      })
      .map(function (a) {
        return {
          name: String(a.name || ""),
          suffix: String(a.suffix || "").trim().toLowerCase(),
        };
      })
      .filter(function (x) {
        if (!needle) return true;
        return (
          x.name.toLowerCase().includes(needle) || x.suffix.indexOf(needle) !== -1
        );
      });

    try {
      console.log("[EMAIL] renderAgencies items", items.length, items);
    } catch (e) {}

    host.innerHTML =
      items
        .map(function (x) {
          var label = x.name + " (" + x.suffix + ")";
          return (
            '<label class="groupItem">' +
            '<input type="checkbox" class="agencyChk" value="' +
            x.suffix +
            '" />' +
            "<span>" +
            label +
            "</span>" +
            "</label>"
          );
        })
        .join("") ||
      '<div style="padding:10px; color: var(--muted);">No agencies found.</div>';
  }

  function renderGroups() {
    var host = $("#emailGroupList");
    if (!host) return;
    var qEl = $("#emailGroupSearch");
    var needle = qEl ? String(qEl.value || "").trim().toLowerCase() : "";

    var items = (Array.isArray(groupsCache) ? groupsCache : [])
      .slice()
      .sort(function (a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""));
      })
      .filter(function (g) {
        if (!needle) return true;
        return String(g.name || "").toLowerCase().includes(needle);
      });

    try {
      console.log("[EMAIL] renderGroups items", items.length, items);
    } catch (e) {}

    host.innerHTML =
      items
        .map(function (g) {
          var id = String(g.pk);
          return (
            '<label class="groupItem">' +
            '<input type="checkbox" class="srcGroupChk" value="' +
            id +
            '" />' +
            "<span>" +
            g.name +
            "</span>" +
            "</label>"
          );
        })
        .join("") ||
      '<div style="padding:10px; color: var(--muted);">No groups found.</div>';
  }

  function applyFilter(listId, searchId) {
    var host = $(listId);
    var search = $(searchId);
    if (!host || !search) return;
    var q = search.value.toLowerCase();
    [].slice.call(host.querySelectorAll(".groupItem")).forEach(function (row) {
      var text = row.textContent.toLowerCase();
      row.style.display = text.indexOf(q) !== -1 ? "" : "none";
    });
  }

  function getSelectedValues(listId) {
    var host = $(listId);
    if (!host) return [];
    var out = [];
    host.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      if (cb.checked) out.push(cb.value);
    });
    return out;
  }

  function setAll(listId, checked) {
    var host = $(listId);
    if (!host) return;
    host.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.checked = checked;
    });
  }

  function resetForm() {
    $("#emailSubject").value = "";
    $("#emailBody").value = "";
    $("#emailUsernames").value = "";
    $("#emailTestOnly").checked = false;
    $("#emailAllConfirm").checked = false;
    setAll("emailAgencyList", false);
    setAll("emailGroupList", false);
    setMode("agency");
    var status = $("#emailStatus");
    if (status) status.textContent = "";
  }

  function collectPayload() {
    var mode = state.mode;
    var agencies = [];
    var groupIds = [];
    var usernames = [];

    if (mode === "agency") {
      agencies = getSelectedValues("emailAgencyList");
    } else if (mode === "groups") {
      groupIds = getSelectedValues("emailGroupList");
    } else if (mode === "users") {
      var raw = $("#emailUsernames").value || "";
      usernames = raw
        .split(/[\n,]/g)
        .map(function (s) {
          return String(s || "").trim();
        })
        .filter(Boolean);
    } else if (mode === "all") {
      if (!state.isGlobalAdmin) {
        throw new Error("Only global admins can email all users.");
      }
      if (!$("#emailAllConfirm").checked) {
        throw new Error("Please confirm that you want to email all users.");
      }
    }

    return {
      mode: mode,
      agencies: agencies,
      groupIds: groupIds,
      usernames: usernames,
      subject: $("#emailSubject").value || "",
      body: $("#emailBody").value || "",
      testOnly: $("#emailTestOnly").checked,
    };
  }

  function init() {
    // If we're not on the email page, bail out early.
    if (!document.getElementById("emailAgencyPane")) {
      return;
    }
    var allModeBtn = $("#allModeBtn");

    // Global admin flag can be passed from EJS if desired
    if (typeof window.EMAIL_IS_GLOBAL_ADMIN !== "undefined") {
      state.isGlobalAdmin = !!window.EMAIL_IS_GLOBAL_ADMIN;
    }

    Promise.all([
      fetch("/api/agencies", { credentials: "same-origin" }),
      fetch("/api/groups", { credentials: "same-origin" }),
    ])
      .then(function (responses) {
        return Promise.all(
          responses.map(function (r) {
            return r.json().then(function (data) {
              return { ok: r.ok, data: data };
            });
          })
        );
      })
      .then(function (results) {
        var status = $("#emailStatus");
        var agenciesRes = results[0];
        var groupsRes = results[1];

        // Basic debug logging to help verify data flow
        try {
          console.log("[EMAIL] agenciesRes", agenciesRes);
          console.log("[EMAIL] groupsRes", groupsRes);
        } catch (e) {}

        if (agenciesRes.ok && Array.isArray(agenciesRes.data)) {
          agenciesCache = agenciesRes.data;
        } else {
          agenciesCache = [];
          if (status) {
            status.classList.add("bad");
            status.textContent =
              (agenciesRes.data && agenciesRes.data.error) ||
              "Failed to load agencies.";
          }
        }

        if (groupsRes.ok && Array.isArray(groupsRes.data)) {
          groupsCache = groupsRes.data;
        } else {
          groupsCache = [];
          if (status) {
            status.classList.add("bad");
            status.textContent =
              (groupsRes.data && groupsRes.data.error) ||
              "Failed to load groups.";
          }
        }

        renderAgencies();
        renderGroups();

        if (state.isGlobalAdmin && allModeBtn) {
          allModeBtn.style.display = "";
        }
      })
      .catch(function (err) {
        var status = $("#emailStatus");
        if (status) {
          status.classList.add("bad");
          status.textContent = err.message || String(err);
        }
      });

    document.querySelectorAll(".segBtn[data-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.getAttribute("data-mode");
        if (mode === "all" && !state.isGlobalAdmin) return;
        setMode(mode);
      });
    });

    // Filters
    var agencySearch = $("#emailAgencySearch");
    if (agencySearch) {
      agencySearch.addEventListener("input", function () {
        applyFilter("emailAgencyList", "emailAgencySearch");
      });
    }
    var groupSearch = $("#emailGroupSearch");
    if (groupSearch) {
      groupSearch.addEventListener("input", function () {
        applyFilter("emailGroupList", "emailGroupSearch");
      });
    }

    // Select/Clear buttons
    var btn;
    btn = $("#emailAgencySelectAll");
    if (btn) btn.addEventListener("click", function () { setAll("emailAgencyList", true); });
    btn = $("#emailAgencyClearAll");
    if (btn) btn.addEventListener("click", function () { setAll("emailAgencyList", false); });
    btn = $("#emailGroupSelectAll");
    if (btn) btn.addEventListener("click", function () { setAll("emailGroupList", true); });
    btn = $("#emailGroupClearAll");
    if (btn) btn.addEventListener("click", function () { setAll("emailGroupList", false); });

    // Reset
    btn = $("#emailResetBtn");
    if (btn) btn.addEventListener("click", function () { resetForm(); });

    // Send
    btn = $("#emailSendBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        var status = $("#emailStatus");
        if (status) {
          status.classList.remove("ok", "bad");
          status.textContent = "";
        }
        var payload;
        try {
          payload = collectPayload();
        } catch (err) {
          if (status) {
            status.classList.add("bad");
            status.textContent = err.message || String(err);
          }
          return;
        }
        fetch("/api/email/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        })
          .then(function (r) {
            return r.json().then(function (data) {
              return { ok: r.ok, data: data };
            });
          })
          .then(function (result) {
            if (!status) return;
            if (result.ok && result.data && result.data.success) {
              status.classList.remove("bad");
              status.classList.add("ok");
              status.textContent =
                "Email queued for " +
                (result.data.count || 0) +
                " recipient(s).";
            } else {
              status.classList.remove("ok");
              status.classList.add("bad");
              status.textContent =
                (result.data && result.data.error) ||
                "Failed to send email.";
            }
          })
          .catch(function (err) {
            if (!status) return;
            status.classList.remove("ok");
            status.classList.add("bad");
            status.textContent = err.message || String(err);
          });
      });
    }

    setMode("agency");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

