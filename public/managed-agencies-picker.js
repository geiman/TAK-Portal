(function (global) {
  "use strict";

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function formatAgencyLabel(a) {
    const name = String(a?.name || a?.suffix || "Agency").trim();
    const abbr = String(a?.groupPrefix || a?.suffix || "").trim();
    return abbr ? name + " (" + abbr + ")" : name;
  }

  function formatSummaryLabel(a) {
    const abbr = String(a?.groupPrefix || a?.suffix || "").trim();
    if (abbr) return abbr;
    return String(a?.name || "").trim();
  }

  function normalizeSuffixValue(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  function resolveHomeSuffix(opts) {
    if (typeof opts.homeSuffix === "function") return normalizeSuffixValue(opts.homeSuffix());
    return normalizeSuffixValue(opts.homeSuffix);
  }

  function mergeWithHome(additional, homeSuffix) {
    const home = normalizeSuffixValue(homeSuffix);
    const out = [];
    const seen = new Set();
    function push(sfx) {
      const norm = normalizeSuffixValue(sfx);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      out.push(norm);
    }
    if (home) push(home);
    (Array.isArray(additional) ? additional : []).forEach(push);
    return out.sort();
  }

  function stripHomeFromManaged(allSuffixes, homeSuffix) {
    const home = normalizeSuffixValue(homeSuffix);
    return (Array.isArray(allSuffixes) ? allSuffixes : [])
      .map(normalizeSuffixValue)
      .filter(Boolean)
      .filter((s) => !home || s !== home);
  }

  function findAgencyBySuffix(agencies, suffix) {
    const needle = normalizeSuffixValue(suffix);
    if (!needle) return null;
    return (Array.isArray(agencies) ? agencies : []).find(
      (a) => normalizeSuffixValue(a?.suffix) === needle
    );
  }

  /**
   * Compact checkbox dropdown for managed-agency selection.
   * @param {HTMLElement} root - element containing .ma-multiselect
   */
  function bindManagedAgenciesPicker(root, opts) {
    opts = opts || {};
    const dropdown = root.querySelector(".ma-multiselect");
    const toggle = root.querySelector(".ma-multiselect-toggle");
    const search = root.querySelector(".ma-multiselect-search");
    const list = root.querySelector(".ma-multiselect-list");
    const selectAll = root.querySelector(".ma-multiselect-select-all");
    const clearBtn = root.querySelector(".ma-multiselect-clear");
    const summary = root.querySelector(".ma-multiselect-summary");
    const inputName = opts.inputName || "managedAgencySuffix";

    let agencies = [];
    let selected = new Set();
    let allAgencies = false;

    function allowAllAgencies() {
      if (typeof opts.allowAllAgencies === "function") return !!opts.allowAllAgencies();
      return !!opts.allowAllAgencies;
    }

    function sortedAgencies() {
      const source = typeof opts.getAgencies === "function" ? opts.getAgencies() : agencies;
      const home = resolveHomeSuffix(opts);
      return (Array.isArray(source) ? source : [])
        .filter((a) => {
          const sfx = normalizeSuffixValue(a?.suffix);
          return !home || sfx !== home;
        })
        .slice()
        .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
    }

    function allAgenciesForLookup() {
      if (typeof opts.getAllAgencies === "function") return opts.getAllAgencies();
      const source = typeof opts.getAgencies === "function" ? opts.getAgencies() : agencies;
      return Array.isArray(source) ? source.slice() : [];
    }

    function updateToggleLabel() {
      if (!toggle) return;
      if (allAgencies) {
        toggle.textContent = "All agencies ▾";
        return;
      }
      const n = selected.size;
      toggle.textContent = n
        ? n + " agenc" + (n === 1 ? "y" : "ies") + " selected ▾"
        : "Select agencies ▾";
    }

    function updateSummary() {
      if (!summary) return;
      if (allAgencies) {
        summary.textContent = "Manages all agencies, including agencies added later.";
        return;
      }
      const home = resolveHomeSuffix(opts);
      const labels = sortedAgencies()
        .filter((a) => selected.has(normalizeSuffixValue(a?.suffix)))
        .map(formatSummaryLabel)
        .filter(Boolean);
      const parts = [];
      if (home) {
        const homeAgency = findAgencyBySuffix(allAgenciesForLookup(), home);
        const homeLabel = homeAgency ? formatSummaryLabel(homeAgency) : home.toUpperCase();
        parts.push("Includes home agency " + homeLabel);
      }
      if (labels.length) {
        parts.push(home ? "Additional: " + labels.join(", ") : "Selected: " + labels.join(", "));
      } else if (home) {
        parts.push("No additional agencies selected.");
      }
      summary.textContent = parts.length ? parts.join(" · ") : "No agencies selected.";
    }

    function renderList() {
      if (!list) return;
      const needle = String(search?.value || "").trim().toLowerCase();
      const visible = sortedAgencies().filter((a) => {
        if (!needle) return true;
        const name = String(a?.name || "").toLowerCase();
        const sfx = String(a?.suffix || "").toLowerCase();
        const abbr = String(a?.groupPrefix || "").toLowerCase();
        return name.includes(needle) || sfx.includes(needle) || abbr.includes(needle);
      });

      const allRow = allowAllAgencies()
        ? '<label class="filter-option ma-multiselect-all-option">' +
          '<input type="checkbox" class="ma-multiselect-all-cb"' +
          (allAgencies ? " checked" : "") +
          " />" +
          "<span><strong>All agencies</strong>" +
          '<small class="muted">Includes agencies added later</small></span>' +
          "</label>"
        : "";

      list.innerHTML =
        allRow +
        (visible
          .map((a) => {
            const sfx = String(a?.suffix || "").trim().toLowerCase();
            const checked = allAgencies || selected.has(sfx) ? " checked" : "";
            const disabled = allAgencies ? " disabled" : "";
            return (
              '<label class="filter-option' +
              (allAgencies ? " is-disabled" : "") +
              '">' +
              '<input type="checkbox" class="ma-multiselect-cb" name="' +
              esc(inputName) +
              '" value="' +
              esc(sfx) +
              '"' +
              checked +
              disabled +
              " />" +
              "<span>" +
              esc(formatAgencyLabel(a)) +
              "</span>" +
              "</label>"
            );
          })
          .join("") || '<div class="muted" style="padding:8px 10px;">No agencies found.</div>');

      updateToggleLabel();
      updateSummary();
    }

    function notifyChange() {
      if (typeof opts.onChange === "function") opts.onChange(selected, { allAgencies: allAgencies });
    }

    function setAllAgencies(next, setOpts) {
      setOpts = setOpts || {};
      allAgencies = !!next && allowAllAgencies();
      renderList();
      if (!setOpts.silent) notifyChange();
    }

    function setSelected(next, setOpts) {
      setOpts = setOpts || {};
      const home = resolveHomeSuffix(opts);
      selected = new Set(
        (next instanceof Set ? Array.from(next) : Array.isArray(next) ? next : [])
          .map(normalizeSuffixValue)
          .filter(Boolean)
          .filter((s) => !home || s !== home)
      );
      renderList();
      if (!setOpts.silent) notifyChange();
    }

    function getSelectedArray() {
      return Array.from(selected).filter(Boolean).sort();
    }

    function getSelectedWithHomeArray() {
      return mergeWithHome(getSelectedArray(), resolveHomeSuffix(opts));
    }

    const menu = dropdown ? dropdown.querySelector(".filter-menu") : null;

    // The menu is position: fixed so it escapes overflow-clipping ancestors (e.g. the
    // Edit User modal). It opens upward when there is more room above the toggle and
    // is capped to the space available, so the list always scrolls within view.
    function positionMenu() {
      if (!menu || !toggle || !dropdown.classList.contains("open")) return;
      const margin = 8;
      const gap = 4;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const r = toggle.getBoundingClientRect();
      const spaceBelow = vh - r.bottom - gap - margin;
      const spaceAbove = r.top - gap - margin;
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxH = Math.max(120, Math.min(360, openUp ? spaceAbove : spaceBelow));
      const width = Math.min(Math.max(r.width, 280), vw - margin * 2);
      const left = Math.min(Math.max(r.left, margin), vw - width - margin);

      menu.classList.add("ma-menu-floating");
      menu.classList.toggle("ma-menu-up", openUp);
      menu.style.position = "fixed";
      menu.style.right = "auto";
      menu.style.bottom = "auto";
      menu.style.width = width + "px";
      menu.style.maxHeight = maxH + "px";
      menu.style.left = left + "px";
      const h = menu.offsetHeight;
      const top = openUp ? r.top - gap - h : r.bottom + gap;
      menu.style.top = top + "px";

      // A transformed/filtered ancestor makes it the containing block for fixed
      // elements; shift by the measured offset so the menu still lines up.
      const actual = menu.getBoundingClientRect();
      const dx = actual.left - left;
      const dy = actual.top - top;
      if (Math.abs(dx) > 0.5) menu.style.left = left - dx + "px";
      if (Math.abs(dy) > 0.5) menu.style.top = top - dy + "px";
    }

    function onViewportChange(e) {
      if (e && e.type === "scroll" && menu && menu.contains(e.target)) return;
      positionMenu();
    }

    function setOpen(open) {
      if (!dropdown) return;
      dropdown.classList.toggle("open", open);
      if (open) {
        positionMenu();
        window.addEventListener("resize", onViewportChange);
        window.addEventListener("scroll", onViewportChange, true);
      } else {
        window.removeEventListener("resize", onViewportChange);
        window.removeEventListener("scroll", onViewportChange, true);
      }
    }

    if (dropdown) dropdown.__maSetOpen = setOpen;

    if (toggle && dropdown) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        document.querySelectorAll(".ma-multiselect.open").forEach(function (el) {
          if (el !== dropdown) closeDropdown(el);
        });
        setOpen(!dropdown.classList.contains("open"));
      });
    }

    if (search) search.addEventListener("input", renderList);

    if (list) {
      list.addEventListener("change", function (e) {
        const cb = e.target;
        if (cb && cb.classList && cb.classList.contains("ma-multiselect-all-cb")) {
          setAllAgencies(cb.checked);
          return;
        }
        if (!cb || cb.type !== "checkbox" || !cb.classList.contains("ma-multiselect-cb")) return;
        const sfx = String(cb.value || "").trim().toLowerCase();
        if (!sfx) return;
        if (cb.checked) selected.add(sfx);
        else selected.delete(sfx);
        updateToggleLabel();
        updateSummary();
        notifyChange();
      });
    }

    if (selectAll) {
      selectAll.addEventListener("click", function () {
        if (allAgencies) return;
        const needle = String(search?.value || "").trim().toLowerCase();
        sortedAgencies().forEach(function (a) {
          const name = String(a?.name || "").toLowerCase();
          const sfx = String(a?.suffix || "").trim().toLowerCase();
          const abbr = String(a?.groupPrefix || "").toLowerCase();
          if (!needle || name.includes(needle) || sfx.includes(needle) || abbr.includes(needle)) {
            if (sfx) selected.add(sfx);
          }
        });
        renderList();
        notifyChange();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        allAgencies = false;
        selected.clear();
        renderList();
        notifyChange();
      });
    }

    if (menu) menu.addEventListener("click", function (e) { e.stopPropagation(); });

    return {
      setAgencies: function (arr) {
        agencies = Array.isArray(arr) ? arr : [];
        renderList();
      },
      setSelected: setSelected,
      setAllAgencies: setAllAgencies,
      getAllAgencies: function () { return allAgencies; },
      getSelected: function () { return new Set(selected); },
      getSelectedArray: getSelectedArray,
      getSelectedWithHomeArray: getSelectedWithHomeArray,
      refresh: function () {
        renderList();
        positionMenu();
      },
    };
  }

  function closeDropdown(el) {
    if (typeof el.__maSetOpen === "function") el.__maSetOpen(false);
    else el.classList.remove("open");
  }

  if (!global.__maMultiselectDocClick) {
    global.__maMultiselectDocClick = true;
    document.addEventListener("click", function () {
      document.querySelectorAll(".ma-multiselect.open").forEach(closeDropdown);
    });
  }

  global.ManagedAgenciesPicker = {
    bind: bindManagedAgenciesPicker,
    mergeWithHome: mergeWithHome,
    stripHomeFromManaged: stripHomeFromManaged,
  };
})(window);
