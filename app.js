/* Storm File — offline snow service log. Data stays in this browser (localStorage). */
(function () {
  const KEY = "stormfile-v1";
  const PHOTO_MAX_EDGE = 960;
  const PHOTO_QUALITY = 0.55;
  const PHOTO_MAX_PER_VISIT = 4;
  const STORAGE_WARN_BYTES = 3.5 * 1024 * 1024;

  const SERVICE_OPTS = [
    ["plow", "Plow"],
    ["shovel", "Shovel / walkways"],
    ["salt", "Salt / ice melt"],
    ["sand", "Sand"],
    ["brine", "Brine"],
    ["inspection", "Inspection / patrol"],
    ["other", "Other"]
  ];

  const REASON_OPTS = [
    ["", "—"],
    ["locked_gate", "Locked gate or no access"],
    ["vehicles", "Vehicles or obstacles in the way"],
    ["unsafe", "Unsafe conditions"],
    ["customer_request", "Customer asked not to service / skip an area"],
    ["equipment", "Equipment problem"],
    ["other", "Other"]
  ];

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyData();
      const data = JSON.parse(raw);
      return {
        operator: data.operator && typeof data.operator === "object" ? data.operator : {},
        properties: Array.isArray(data.properties) ? data.properties : [],
        visits: Array.isArray(data.visits) ? data.visits : []
      };
    } catch (e) {
      return emptyData();
    }
  }
  function emptyData() {
    return { operator: {}, properties: [], visits: [] };
  }
  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }
  function uid() {
    return "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function nowISO() {
    return new Date().toISOString();
  }
  function fmtStamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  function duration(a, b) {
    if (!a || !b) return "";
    const ms = new Date(b) - new Date(a);
    if (!isFinite(ms) || ms < 0) return "";
    const m = Math.round(ms / 60000);
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h ? h + "h " + r + "m" : m + " min";
  }
  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function slug(s) {
    return String(s || "property")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "property";
  }
  function storageSize() {
    const raw = localStorage.getItem(KEY) || "";
    return raw.length * 2;
  }
  function serviceLabels(codes, other) {
    const map = Object.fromEntries(SERVICE_OPTS);
    return (codes || [])
      .map((c) => (c === "other" && other ? other : map[c] || c))
      .filter(Boolean)
      .join(", ");
  }
  function reasonLabel(code) {
    const hit = REASON_OPTS.find((r) => r[0] === code);
    return hit ? hit[1] : code || "";
  }
  function val(form, name) {
    const el = form.elements[name];
    return el ? String(el.value || "").trim() : "";
  }
  function checked(form, name) {
    return $$("input[name='" + name + "']:checked", form).map((el) => el.value);
  }
  function siteBase() {
    const script = document.querySelector("script[src*='app.js']");
    if (script && script.src) return new URL(".", script.src).href;
    return new URL("../", location.href).href;
  }

  function downscaleImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        const edge = Math.max(w, h);
        const scale = edge > PHOTO_MAX_EDGE ? PHOTO_MAX_EDGE / edge : 1;
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
        resolve({ name: (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", dataUrl, takenAt: nowISO() });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
      };
      img.src = url;
    });
  }

  const root = document.getElementById("storm-app");
  if (!root) return;

  const state = { view: "list", propertyId: null, visitId: null, editingProperty: false, offlineReady: false };

  function currentProperty(data) {
    return data.properties.find((p) => p.id === state.propertyId) || null;
  }
  function visitsFor(data, propertyId) {
    return data.visits
      .filter((v) => v.propertyId === propertyId)
      .sort((a, b) => String(b.arrivedAt || b.createdAt || "").localeCompare(String(a.arrivedAt || a.createdAt || "")));
  }
  function openVisit(data, propertyId) {
    return data.visits.find((v) => v.propertyId === propertyId && v.arrivedAt && !v.departedAt) || null;
  }

  function setView(view, ids) {
    state.view = view;
    if (ids && ids.propertyId !== undefined) state.propertyId = ids.propertyId;
    if (ids && ids.visitId !== undefined) state.visitId = ids.visitId;
    if (ids && ids.editingProperty !== undefined) state.editingProperty = ids.editingProperty;
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    const data = load();
    if (state.view === "settings") root.innerHTML = viewSettings(data);
    else if (state.view === "property-form") root.innerHTML = viewPropertyForm(data);
    else if (state.view === "property") root.innerHTML = viewProperty(data);
    else if (state.view === "visit") root.innerHTML = viewVisit(data);
    else if (state.view === "report") root.innerHTML = viewReport(data);
    else root.innerHTML = viewList(data);
    bind();
  }

  function offlinePill() {
    const cls = state.offlineReady ? "" : " off";
    const label = state.offlineReady ? "Offline ready" : navigator.onLine === false ? "Offline" : "Online";
    return '<span class="status-pill' + cls + '" data-offline-pill="1">' + esc(label) + "</span>";
  }

  function storageBanner() {
    const n = storageSize();
    if (n < STORAGE_WARN_BYTES) return "";
    return (
      '<div class="storage-warn" role="status">This browser copy is getting large (' +
      Math.round(n / 1024) +
      " KB), mostly from photos. Export a season report or a backup, then remove older photos if saving starts to fail.</div>"
    );
  }

  function viewList(data) {
    const items = data.properties
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .map((p) => {
        const visits = visitsFor(data, p.id);
        const open = openVisit(data, p.id);
        const last = visits[0];
        const sub = open
          ? "On site since " + fmtStamp(open.arrivedAt)
          : last
            ? "Last visit " + fmtStamp(last.arrivedAt || last.createdAt)
            : "No visits yet";
        return (
          '<li><a href="#property/' +
          encodeURIComponent(p.id) +
          '" data-go="property" data-id="' +
          esc(p.id) +
          '"><strong>' +
          esc(p.name || "Untitled property") +
          "</strong><span class='muted'>" +
          esc(p.address || "No address") +
          " · " +
          esc(sub) +
          "</span></a></li>"
        );
      })
      .join("");
    return (
      '<div class="app-bar"><h1>Service log</h1>' +
      offlinePill() +
      "</div>" +
      storageBanner() +
      '<p class="hint">Your properties and visits stay in this browser. Nothing is uploaded. Add a property, then tap Arrive when you pull in.</p>' +
      (items ? '<ul class="property-list">' + items + "</ul>" : '<p class="empty">No properties yet. Add the first driveway or lot you service.</p>') +
      '<div class="actions-row">' +
      '<button type="button" class="btn btn-salt" data-go="property-form">Add property</button>' +
      '<button type="button" class="btn btn-outline" data-go="settings">Operator &amp; backup</button>' +
      "</div>"
    );
  }

  function viewPropertyForm(data) {
    const p = state.editingProperty && currentProperty(data);
    const title = p ? "Edit property" : "New property";
    return (
      '<div class="app-bar"><h1>' +
      title +
      '</h1><button type="button" class="btn btn-outline" data-go="' +
      (p ? "property" : "list") +
      '">Back</button></div>' +
      '<form id="property-form" class="card form-grid">' +
      '<input type="hidden" name="id" value="' +
      esc(p ? p.id : "") +
      '">' +
      '<label class="field">Property name<input name="name" required value="' +
      esc(p ? p.name : "") +
      '" placeholder="12 Oak Street or Smith driveway"></label>' +
      '<label class="field">Address<input name="address" value="' +
      esc(p ? p.address : "") +
      '" placeholder="Street, city"></label>' +
      '<label class="field">Season label<input name="season" value="' +
      esc(p ? p.season : "2026–2027") +
      '" placeholder="2026–2027"></label>' +
      '<label class="field">Trigger depth (inches)<input name="triggerInches" inputmode="decimal" value="' +
      esc(p && p.triggerInches != null ? p.triggerInches : "") +
      '" placeholder="e.g. 2"></label>' +
      '<label class="field">Surfaces included<textarea name="surfaces" placeholder="Driveway, apron, sidewalk, steps">' +
      esc(p ? p.surfaces : "") +
      "</textarea></label>" +
      '<label class="field">Notes (access, pile locations, customer instructions)<textarea name="notes">' +
      esc(p ? p.notes : "") +
      "</textarea></label>" +
      '<div class="actions-row"><button type="submit" class="btn btn-salt">Save property</button></div>' +
      "</form>"
    );
  }

  function viewProperty(data) {
    const p = currentProperty(data);
    if (!p) return '<p>Property not found.</p><button type="button" class="btn btn-outline" data-go="list">Back</button>';
    const open = openVisit(data, p.id);
    const visits = visitsFor(data, p.id);
    const rows = visits
      .map((v) => {
        const mid = open && open.id === v.id ? " · in progress" : v.departedAt ? " · " + duration(v.arrivedAt, v.departedAt) : "";
        return (
          '<li><div class="visit-row" data-go="visit" data-id="' +
          esc(v.id) +
          '"><strong>' +
          esc(fmtStamp(v.arrivedAt || v.createdAt)) +
          mid +
          "</strong><div class='meta'><span>" +
          esc(serviceLabels(v.services, v.otherService) || "No service marked") +
          "</span><span>Depth " +
          esc(v.snowDepthInches === "" || v.snowDepthInches == null ? "—" : v.snowDepthInches + " in") +
          "</span></div></div></li>"
        );
      })
      .join("");
    const openBox = open
      ? '<div class="open-visit"><strong>You are on site.</strong><p>Arrived ' +
        esc(fmtStamp(open.arrivedAt)) +
        '. Finish the log, then tap Depart.</p><div class="actions-row">' +
        '<button type="button" class="btn btn-salt" data-go="visit" data-id="' +
        esc(open.id) +
        '">Continue this visit</button></div></div>'
      : "";
    return (
      '<div class="app-bar"><h1>' +
      esc(p.name) +
      '</h1><button type="button" class="btn btn-outline" data-go="list">All properties</button></div>' +
      storageBanner() +
      '<p class="muted">' +
      esc([p.address, p.season, p.triggerInches ? "Trigger " + p.triggerInches + " in" : ""].filter(Boolean).join(" · ")) +
      "</p>" +
      openBox +
      (open
        ? ""
        : '<div class="punch"><button type="button" class="btn btn-salt btn-lg" data-arrive="' +
          esc(p.id) +
          '">Arrive<small>Stamps the time now</small></button>' +
          '<button type="button" class="btn btn-outline btn-lg" disabled>Depart<small>Start a visit first</small></button></div>') +
      '<div class="actions-row">' +
      '<button type="button" class="btn btn-outline" data-go="property-form" data-edit="1">Edit property</button>' +
      '<button type="button" class="btn btn-outline" data-go="report">Print season report</button>' +
      '<button type="button" class="btn btn-outline" data-csv="1">Download CSV</button>' +
      "</div>" +
      "<h2>Visits</h2>" +
      (rows ? '<ul class="visit-list">' + rows + "</ul>" : '<p class="empty">No visits logged yet.</p>') +
      '<div class="actions-row"><button type="button" class="btn btn-danger" data-delete-property="' +
      esc(p.id) +
      '">Delete property and its visits</button></div>'
    );
  }

  function viewVisit(data) {
    const v = data.visits.find((x) => x.id === state.visitId);
    if (!v) return '<p>Visit not found.</p><button type="button" class="btn btn-outline" data-go="property">Back</button>';
    const p = data.properties.find((x) => x.id === v.propertyId);
    const services = SERVICE_OPTS.map((opt) => {
      const on = (v.services || []).indexOf(opt[0]) >= 0;
      return (
        '<label><input type="checkbox" name="services" value="' +
        esc(opt[0]) +
        '"' +
        (on ? " checked" : "") +
        "> " +
        esc(opt[1]) +
        "</label>"
      );
    }).join("");
    const reasons = REASON_OPTS.map((opt) => {
      const on = (v.notServicedReason || "") === opt[0];
      return '<option value="' + esc(opt[0]) + '"' + (on ? " selected" : "") + ">" + esc(opt[1]) + "</option>";
    }).join("");
    const thumbs = (v.photos || [])
      .map((ph, i) => {
        return (
          '<figure><img src="' +
          esc(ph.dataUrl) +
          '" alt="Visit photo ' +
          (i + 1) +
          '"><button type="button" data-del-photo="' +
          i +
          '" aria-label="Remove photo">×</button></figure>'
        );
      })
      .join("");
    return (
      '<div class="app-bar"><h1>' +
      esc(p ? p.name : "Visit") +
      '</h1><button type="button" class="btn btn-outline" data-go="property">Back</button></div>' +
      storageBanner() +
      '<div class="punch">' +
      '<button type="button" class="btn btn-salt btn-lg" data-punch="arrive">Arrive<small>' +
      esc(fmtTime(v.arrivedAt)) +
      "</small></button>" +
      '<button type="button" class="btn btn-ice btn-lg" data-punch="depart">Depart<small>' +
      esc(fmtTime(v.departedAt)) +
      "</small></button></div>" +
      (v.arrivedAt && v.departedAt
        ? '<p class="hint">Time on site: ' + esc(duration(v.arrivedAt, v.departedAt)) + ".</p>"
        : '<p class="hint">Arrive and Depart stamp the time to the minute. You can retap if you stamped early by mistake; the new time replaces the old one.</p>') +
      '<form id="visit-form" class="form-grid">' +
      '<div class="row-2"><label class="field">Snow depth (inches)<span class="hint">A measurement or a stated estimate. Leave blank if you did not measure.</span><input name="snowDepthInches" inputmode="decimal" value="' +
      esc(v.snowDepthInches == null ? "" : v.snowDepthInches) +
      '"></label>' +
      '<label class="field">Operator name<input name="operatorName" value="' +
      esc(v.operatorName || (data.operator && data.operator.name) || "") +
      '"></label></div>' +
      '<fieldset class="field"><legend>Service type</legend><div class="checks">' +
      services +
      '</div></fieldset>' +
      '<label class="field">Other service (if checked)<input name="otherService" value="' +
      esc(v.otherService || "") +
      '"></label>' +
      '<div class="row-2"><label class="field">Material type<input name="materialType" value="' +
      esc(v.materialType || "") +
      '" placeholder="Rock salt, ice melt, sand, brine"></label>' +
      '<label class="field">Amount + unit<input name="materialAmount" value="' +
      esc(v.materialAmount || "") +
      '" placeholder="e.g. 40 lb or 2 bags"></label></div>' +
      '<label class="field">Weather notes<span class="hint">SIMA advises recording temperature, precipitation, or ice only with a reliable source or measurement. Name that source below.</span><textarea name="weatherNotes">' +
      esc(v.weatherNotes || "") +
      '</textarea></label>' +
      '<label class="field">Weather source<input name="weatherSource" value="' +
      esc(v.weatherSource || "") +
      '" placeholder="NWS, on-site thermometer, customer report…"></label>' +
      '<label class="field">Areas serviced<textarea name="areasServiced" placeholder="Driveway, sidewalk, steps">' +
      esc(v.areasServiced || "") +
      "</textarea></label>" +
      '<label class="field">Areas not serviced<textarea name="areasNotServiced">' +
      esc(v.areasNotServiced || "") +
      "</textarea></label>" +
      '<label class="field">If you could not service, why?<select name="notServicedReason">' +
      reasons +
      "</select></label>" +
      '<label class="field">Follow-up taken<textarea name="followUp" placeholder="Called the customer, will return after cars are moved…">' +
      esc(v.followUp || "") +
      "</textarea></label>" +
      '<label class="field">Factual notes<span class="hint">Stick to actions and observations. Avoid guesses, opinions, or comments about fault.</span><textarea name="notes">' +
      esc(v.notes || "") +
      "</textarea></label>" +
      '<div class="field"><span>Photos (' +
      (v.photos || []).length +
      " of " +
      PHOTO_MAX_PER_VISIT +
      ')</span><span class="hint">Stored only on this device, downscaled to keep the log small. Before-and-after shots help.</span>' +
      '<input id="photo-input" type="file" accept="image/*" capture="environment" ' +
      ((v.photos || []).length >= PHOTO_MAX_PER_VISIT ? "disabled " : "") +
      ">" +
      '<div class="thumbs">' +
      thumbs +
      "</div></div>" +
      '<div class="actions-row"><button type="submit" class="btn btn-salt">Save visit</button>' +
      '<button type="button" class="btn btn-danger" data-delete-visit="1">Delete visit</button></div>' +
      "</form>"
    );
  }

  function viewSettings(data) {
    const o = data.operator || {};
    return (
      '<div class="app-bar"><h1>Operator &amp; backup</h1><button type="button" class="btn btn-outline" data-go="list">Back</button></div>' +
      '<form id="operator-form" class="card form-grid">' +
      '<label class="field">Your name<input name="name" value="' +
      esc(o.name || "") +
      '"></label>' +
      '<label class="field">Business name<input name="business" value="' +
      esc(o.business || "") +
      '"></label>' +
      '<label class="field">Phone<input name="phone" value="' +
      esc(o.phone || "") +
      '"></label>' +
      '<label class="field">Email<input name="email" value="' +
      esc(o.email || "") +
      '"></label>' +
      '<div class="actions-row"><button type="submit" class="btn btn-salt">Save</button></div>' +
      "</form>" +
      '<div class="card" style="margin-top:1rem">' +
      "<h2>Backup</h2><p>Download a copy of this browser’s log. Keep it somewhere safe. You can import it later on this phone or another one.</p>" +
      '<div class="actions-row">' +
      '<button type="button" class="btn btn-outline" data-backup="full">Download full backup (JSON)</button>' +
      '<button type="button" class="btn btn-outline" data-backup="nophotos">Backup without photos</button>' +
      "</div>" +
      '<label class="field" style="margin-top:1rem">Import a backup<input id="import-backup" type="file" accept="application/json,.json"></label>' +
      '<p class="hint">Import replaces the log currently in this browser, after you confirm.</p>' +
      "</div>"
    );
  }

  function viewReport(data) {
    const p = currentProperty(data);
    if (!p) return '<p>Property not found.</p>';
    const o = data.operator || {};
    const visits = visitsFor(data, p.id).slice().reverse();
    const finished = visits.filter((v) => v.arrivedAt && v.departedAt);
    const minutes = finished.reduce((sum, v) => {
      const ms = new Date(v.departedAt) - new Date(v.arrivedAt);
      return sum + (isFinite(ms) && ms > 0 ? ms : 0);
    }, 0);
    const blocks = visits
      .map((v) => {
        const photos = (v.photos || [])
          .map((ph, i) => '<img src="' + esc(ph.dataUrl) + '" alt="Photo ' + (i + 1) + ' from ' + esc(fmtStamp(ph.takenAt)) + '">')
          .join("");
        return (
          '<section class="visit-block">' +
          "<h3>" +
          esc(fmtStamp(v.arrivedAt || v.createdAt)) +
          "</h3>" +
          "<table><tbody>" +
          row("Arrived", fmtStamp(v.arrivedAt)) +
          row("Departed", fmtStamp(v.departedAt)) +
          row("Time on site", duration(v.arrivedAt, v.departedAt) || "—") +
          row("Operator", v.operatorName || "—") +
          row("Snow depth", v.snowDepthInches === "" || v.snowDepthInches == null ? "—" : v.snowDepthInches + " in") +
          row("Services", serviceLabels(v.services, v.otherService) || "—") +
          row("Materials", [v.materialType, v.materialAmount].filter(Boolean).join(" · ") || "—") +
          row("Weather notes", v.weatherNotes || "—") +
          row("Weather source", v.weatherSource || "—") +
          row("Areas serviced", v.areasServiced || "—") +
          row("Areas not serviced", v.areasNotServiced || "—") +
          row("Could not service", reasonLabel(v.notServicedReason) || "—") +
          row("Follow-up", v.followUp || "—") +
          row("Notes", v.notes || "—") +
          "</tbody></table>" +
          (photos ? '<div class="photo-grid">' + photos + "</div>" : "") +
          "</section>"
        );
      })
      .join("");
    return (
      '<div class="report" id="season-report">' +
      '<div class="app-bar no-print"><h1>Season report</h1><div class="actions-row">' +
      '<button type="button" class="btn btn-outline" data-go="property">Back</button>' +
      '<button type="button" class="btn btn-salt" data-print="1">Print / save PDF</button>' +
      "</div></div>" +
      '<header class="report-header">' +
      "<h1>Snow and ice service log</h1>" +
      "<p><strong>" +
      esc(o.business || o.name || "Operator") +
      "</strong>" +
      (o.phone || o.email ? " · " + esc([o.phone, o.email].filter(Boolean).join(" · ")) : "") +
      "</p>" +
      "<p><strong>Property:</strong> " +
      esc(p.name) +
      (p.address ? " — " + esc(p.address) : "") +
      "<br><strong>Season:</strong> " +
      esc(p.season || "—") +
      (p.triggerInches ? " · Trigger " + esc(p.triggerInches) + " in" : "") +
      (p.surfaces ? "<br><strong>Surfaces:</strong> " + esc(p.surfaces) : "") +
      "</p>" +
      "<p><strong>Visits in this report:</strong> " +
      visits.length +
      " · <strong>Completed visits:</strong> " +
      finished.length +
      " · <strong>Recorded time on site:</strong> " +
      esc((minutes > 0 ? Math.round(minutes / 60000) + " min" : "—")) +
      "<br><strong>Printed:</strong> " +
      esc(fmtStamp(nowISO())) +
      "</p>" +
      "</header>" +
      '<aside class="disclaimer" role="note"><strong>About this report</strong><p>This is a record kept by the operator in a web browser. It is not an official form, not legal advice, and not a guarantee of site conditions after service. Ice and snow can form after a visit. Photos and times come from this device and were not independently certified.</p></aside>' +
      (p.notes ? "<p><strong>Property notes:</strong> " + esc(p.notes) + "</p>" : "") +
      (blocks || "<p>No visits recorded.</p>") +
      "</div>"
    );
  }

  function row(k, v) {
    return "<tr><th>" + esc(k) + "</th><td>" + esc(v) + "</td></tr>";
  }

  function bind() {
    $$("[data-go]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const go = el.getAttribute("data-go");
        if (go === "property") setView("property", { propertyId: el.getAttribute("data-id") || state.propertyId });
        else if (go === "visit") setView("visit", { visitId: el.getAttribute("data-id") });
        else if (go === "property-form") setView("property-form", { editingProperty: el.getAttribute("data-edit") === "1" });
        else if (go === "report") setView("report");
        else if (go === "settings") setView("settings");
        else setView("list");
      });
    });

    const pf = $("#property-form");
    if (pf) {
      pf.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const data = load();
        const id = val(pf, "id") || uid();
        const rec = {
          id,
          name: val(pf, "name"),
          address: val(pf, "address"),
          season: val(pf, "season"),
          triggerInches: val(pf, "triggerInches"),
          surfaces: val(pf, "surfaces"),
          notes: val(pf, "notes")
        };
        const i = data.properties.findIndex((p) => p.id === id);
        if (i >= 0) data.properties[i] = rec;
        else data.properties.push(rec);
        save(data);
        setView("property", { propertyId: id, editingProperty: false });
      });
    }

    $$("[data-arrive]").forEach((el) => {
      el.addEventListener("click", () => startVisit(el.getAttribute("data-arrive")));
    });
    $$("[data-punch]").forEach((el) => {
      el.addEventListener("click", () => punch(el.getAttribute("data-punch")));
    });
    $$("[data-delete-property]").forEach((el) => {
      el.addEventListener("click", () => {
        if (!confirm("Delete this property and every visit logged for it on this device?")) return;
        const data = load();
        const id = el.getAttribute("data-delete-property");
        data.properties = data.properties.filter((p) => p.id !== id);
        data.visits = data.visits.filter((v) => v.propertyId !== id);
        save(data);
        setView("list", { propertyId: null });
      });
    });
    $$("[data-csv]").forEach((el) => {
      el.addEventListener("click", exportCsv);
    });
    $$("[data-print]").forEach((el) => {
      el.addEventListener("click", () => window.print());
    });

    const vf = $("#visit-form");
    if (vf) {
      vf.addEventListener("submit", (ev) => {
        ev.preventDefault();
        saveVisitFromForm(vf);
        setView("property");
      });
      const photo = $("#photo-input");
      if (photo) {
        photo.addEventListener("change", async () => {
          const file = photo.files && photo.files[0];
          photo.value = "";
          if (!file) return;
          try {
            if (form) saveVisitFromForm(form);
            const shot = await downscaleImage(file);
            const data = load();
            const v = data.visits.find((x) => x.id === state.visitId);
            if (!v) return;
            v.photos = v.photos || [];
            if (v.photos.length >= PHOTO_MAX_PER_VISIT) return;
            v.photos.push(shot);
            v.updatedAt = nowISO();
            save(data);
            render();
          } catch (err) {
            alert(err.message || "Could not add that photo.");
          }
        });
      }
      $$("[data-del-photo]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (form) saveVisitFromForm(form);
          const data = load();
          const v = data.visits.find((x) => x.id === state.visitId);
          if (!v) return;
          v.photos.splice(Number(btn.getAttribute("data-del-photo")), 1);
          v.updatedAt = nowISO();
          save(data);
          render();
        });
      });
      const del = $("[data-delete-visit]");
      if (del) {
        del.addEventListener("click", () => {
          if (!confirm("Delete this visit from this device?")) return;
          const data = load();
          data.visits = data.visits.filter((v) => v.id !== state.visitId);
          save(data);
          setView("property", { visitId: null });
        });
      }
    }

    const of = $("#operator-form");
    if (of) {
      of.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const data = load();
        data.operator = {
          name: val(of, "name"),
          business: val(of, "business"),
          phone: val(of, "phone"),
          email: val(of, "email")
        };
        save(data);
        setView("list");
      });
    }
    $$("[data-backup]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-backup");
        let data = load();
        if (kind === "nophotos") {
          data = JSON.parse(JSON.stringify(data));
          data.visits.forEach((v) => {
            v.photos = [];
          });
        }
        download("storm-file-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(data, null, 2), "application/json");
      });
    });
    const imp = $("#import-backup");
    if (imp) {
      imp.addEventListener("change", () => {
        const file = imp.files && imp.files[0];
        imp.value = "";
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result || ""));
            if (!parsed || !Array.isArray(parsed.properties) || !Array.isArray(parsed.visits)) {
              throw new Error("That file does not look like a Storm File backup.");
            }
            if (!confirm("Replace the log in this browser with the imported backup?")) return;
            save({
              operator: parsed.operator && typeof parsed.operator === "object" ? parsed.operator : {},
              properties: parsed.properties,
              visits: parsed.visits
            });
            setView("list");
          } catch (err) {
            alert(err.message || "Could not import that file.");
          }
        };
        reader.readAsText(file);
      });
    }
  }

  function collectVisit(form, v) {
    return Object.assign({}, v, {
      snowDepthInches: val(form, "snowDepthInches"),
      operatorName: val(form, "operatorName"),
      services: checked(form, "services"),
      otherService: val(form, "otherService"),
      materialType: val(form, "materialType"),
      materialAmount: val(form, "materialAmount"),
      weatherNotes: val(form, "weatherNotes"),
      weatherSource: val(form, "weatherSource"),
      areasServiced: val(form, "areasServiced"),
      areasNotServiced: val(form, "areasNotServiced"),
      notServicedReason: val(form, "notServicedReason"),
      followUp: val(form, "followUp"),
      notes: val(form, "notes"),
      updatedAt: nowISO()
    });
  }

  function saveVisitFromForm(form) {
    const data = load();
    const i = data.visits.findIndex((x) => x.id === state.visitId);
    if (i < 0) return;
    data.visits[i] = collectVisit(form, data.visits[i]);
    save(data);
  }

  function startVisit(propertyId) {
    const data = load();
    if (openVisit(data, propertyId)) {
      const existing = openVisit(data, propertyId);
      setView("visit", { propertyId, visitId: existing.id });
      return;
    }
    const rec = {
      id: uid(),
      propertyId,
      arrivedAt: nowISO(),
      departedAt: "",
      snowDepthInches: "",
      services: [],
      otherService: "",
      materialType: "",
      materialAmount: "",
      weatherNotes: "",
      weatherSource: "",
      areasServiced: "",
      areasNotServiced: "",
      notServicedReason: "",
      followUp: "",
      operatorName: (data.operator && data.operator.name) || "",
      notes: "",
      photos: [],
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    data.visits.push(rec);
    save(data);
    setView("visit", { propertyId, visitId: rec.id });
  }

  function punch(kind) {
    const form = $("#visit-form");
    const data = load();
    const i = data.visits.findIndex((x) => x.id === state.visitId);
    if (i < 0) return;
    let v = data.visits[i];
    if (form) v = collectVisit(form, v);
    if (kind === "arrive") v.arrivedAt = nowISO();
    if (kind === "depart") {
      if (!v.arrivedAt) v.arrivedAt = nowISO();
      v.departedAt = nowISO();
    }
    v.updatedAt = nowISO();
    data.visits[i] = v;
    save(data);
    render();
  }

  function exportCsv() {
    const data = load();
    const p = currentProperty(data);
    if (!p) return;
    const visits = visitsFor(data, p.id).slice().reverse();
    const header = [
      "property_name",
      "property_address",
      "season",
      "arrived_at",
      "departed_at",
      "minutes_on_site",
      "operator",
      "snow_depth_inches",
      "services",
      "material_type",
      "material_amount",
      "weather_notes",
      "weather_source",
      "areas_serviced",
      "areas_not_serviced",
      "could_not_service_reason",
      "follow_up",
      "notes",
      "photo_count"
    ];
    const lines = [header.join(",")];
    visits.forEach((v) => {
      const mins =
        v.arrivedAt && v.departedAt ? Math.round((new Date(v.departedAt) - new Date(v.arrivedAt)) / 60000) : "";
      lines.push(
        [
          p.name,
          p.address,
          p.season,
          v.arrivedAt || "",
          v.departedAt || "",
          mins,
          v.operatorName || "",
          v.snowDepthInches || "",
          serviceLabels(v.services, v.otherService),
          v.materialType || "",
          v.materialAmount || "",
          v.weatherNotes || "",
          v.weatherSource || "",
          v.areasServiced || "",
          v.areasNotServiced || "",
          reasonLabel(v.notServicedReason),
          v.followUp || "",
          v.notes || "",
          (v.photos || []).length
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    download("storm-file-" + slug(p.name) + "-log.csv", lines.join("\r\n"), "text/csv;charset=utf-8");
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    const swUrl = new URL("sw.js", siteBase()).toString();
    navigator.serviceWorker
      .register(swUrl)
      .then(() => {
        state.offlineReady = true;
        const pill = $("[data-offline-pill]");
        if (pill) {
          pill.textContent = "Offline ready";
          pill.classList.remove("off");
        }
      })
      .catch(() => {});
  }

  window.StormFile = {
    KEY,
    load,
    save,
    render,
    startVisit,
    setView,
    state
  };

  render();
  registerWorker();
})();
