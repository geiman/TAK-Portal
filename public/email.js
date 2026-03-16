(function () {
  function $(id) {
    return document.getElementById(id);
  }

  var state = {
    isGlobalAdmin: false,
    agencies: [],
    groups: [],
    mode: "agency",
  };

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".segBtn[data-mode]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
    });
    $("#emailAgencyPane").style.display = mode === "agency" ? "" : "none";
    $("#emailGroupsPane").style.display = mode === "groups" ? "" : "none";
    $("#emailUsersPane").style.display = mode === "users" ? "" : "none";
    $("#emailAllPane").style.display = mode === "all" ? "" : "none";
  }

  function renderAgencies() {
    var host = $("#emailAgencyList");
    if (!host) return;
    host.innerHTML = "";
    state.agencies.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "groupItem";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.value = a.suffix;
      var label = document.createElement("span");
      label.textContent = a.name + " (" + a.suffix + ")";
      row.appendChild(input);
      row.appendChild(label);
      host.appendChild(row);
    });
  }

  function renderGroups() {
    var host = $("#emailGroupList");
    if (!host) return;
    host.innerHTML = "";
    state.groups.forEach(function (g) {
      var row = document.createElement("div");
      row.className = "groupItem";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.value = g.pk;
      var label = document.createElement("span");
      label.textContent = g.name;
      row.appendChild(input);
      row.appendChild(label);
      host.appendChild(row);
    });
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
    var allModeBtn = $("#allModeBtn");

    fetch("/api/email/meta", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("Failed to load email metadata.");
        return r.json();
      })
      .then(function (data) {
        state.isGlobalAdmin = !!data.isGlobalAdmin;
        state.agencies = Array.isArray(data.agencies) ? data.agencies : [];
        state.groups = Array.isArray(data.groups) ? data.groups : [];
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

