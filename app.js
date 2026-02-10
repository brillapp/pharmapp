/* app.js — Ventas Offline (PWA) + Supabase
 * - Multi-delegado por zona (CCAA u otras)
 * - Roles: delegado / admin (admin gestiona usuarios+zonas y backups/ajustes)
 * - Offline: IndexedDB + SW
 * - Sync: outbox best-effort (pull zone -> IDB, push local changes)
 *
 * IMPORTANTE: configura en Ajustes:
 *   - Supabase URL
 *   - Supabase Anon Key
 * y crea las tablas/policies con /supabase/schema.sql
 */
(() => {
  "use strict";

  /**********************
   * DOM helpers
   **********************/
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /**********************
   * Toast
   **********************/
  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = "none"), ms);
  }

  /**********************
   * Escape helpers
   **********************/
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll("\n", " ");
  }

  /**********************
   * Formatting
   **********************/
  function nowISO() {
    return new Date().toISOString();
  }
  function fmtEur(n) {
    const v = Number(n || 0);
    return v.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
  }
  function fmtEurShort(n) {
    const v = Number(n || 0);
    if (v >= 1000) return (v / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 }) + "K €";
    return fmtEur(v);
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("es-ES");
  }
  function todayYMD() {
    return new Date().toISOString().slice(0, 10);
  }
  function parseISODateYMD(ymd) {
    // ymd = "2026-01-12"
    if (!ymd) return null;
    const d = new Date(ymd + "T10:00:00");
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  /**********************
   * UID
   **********************/
  function uid() {
    return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
  }

  /**********************
   * Quarter helpers
   **********************/
  function quarterKey(date) {
    const d = new Date(date);
    const y = String(d.getFullYear()).slice(-2);
    const m = d.getMonth(); // 0..11
    const q = m < 3 ? 1 : m < 6 ? 2 : m < 9 ? 3 : 4;
    return `${q}T${y}`;
  }
  function quarterBounds(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = d.getMonth();
    const q = m < 3 ? 0 : m < 6 ? 3 : m < 9 ? 6 : 9;
    const start = new Date(y, q, 1, 0, 0, 0, 0);
    const end = new Date(y, q + 3, 1, 0, 0, 0, 0);
    return { start, end };
  }

  /**********************
   * IndexedDB
   **********************/
  const DB_NAME = "ventas_offline_db";
  const DB_VER = 5;

  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);

      req.onupgradeneeded = () => {
        const d = req.result;

        // Entidades (farmacias / opticas)
        if (!d.objectStoreNames.contains("farmacias")) {
          const s = d.createObjectStore("farmacias", { keyPath: "id" });
          s.createIndex("by_codigo", "codigo", { unique: false });
          s.createIndex("by_cliente", "cliente", { unique: false });
          s.createIndex("by_concello", "concello", { unique: false });
        }
        if (!d.objectStoreNames.contains("misFarmacias")) {
          d.createObjectStore("misFarmacias", { keyPath: "id" }); // {id, entityId, createdAt}
        }

        if (!d.objectStoreNames.contains("opticas")) {
          const s = d.createObjectStore("opticas", { keyPath: "id" });
          s.createIndex("by_codigo", "codigo", { unique: false });
          s.createIndex("by_cliente", "cliente", { unique: false });
          s.createIndex("by_ciudad", "ciudad", { unique: false });
        }
        if (!d.objectStoreNames.contains("misOpticas")) {
          d.createObjectStore("misOpticas", { keyPath: "id" }); // {id, entityId, createdAt}
        }

        if (!d.objectStoreNames.contains("productos")) {
          d.createObjectStore("productos", { keyPath: "id" });
        }

        if (!d.objectStoreNames.contains("pedidos")) {
          const s = d.createObjectStore("pedidos", { keyPath: "id" });
          s.createIndex("by_entity", "entityId", { unique: false });
          s.createIndex("by_tipo", "entityType", { unique: false });
          s.createIndex("by_fecha", "fecha", { unique: false });
        }

        if (!d.objectStoreNames.contains("visitas")) {
          const s = d.createObjectStore("visitas", { keyPath: "id" });
          s.createIndex("by_entity", "entityId", { unique: false });
          s.createIndex("by_tipo", "entityType", { unique: false });
          s.createIndex("by_fecha", "fecha", { unique: false });
          s.createIndex("by_day", "day", { unique: false });
        }

        if (!d.objectStoreNames.contains("settings")) {
          d.createObjectStore("settings", { keyPath: "key" }); // {key, value}
        }

        if (!d.objectStoreNames.contains("auth")) {
          d.createObjectStore("auth", { keyPath: "key" }); // {key, value}
        }

        // cola local de operaciones para sync (best-effort)
        if (!d.objectStoreNames.contains("outbox")) {
          const s = d.createObjectStore("outbox", { keyPath: "id" }); // {id, op, store, key, data, createdAt}
          s.createIndex("by_createdAt", "createdAt", { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode = "readonly") {
    return db.transaction(store, mode).objectStore(store);
  }

  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const r = tx(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  }

  async function dbPutLocal(store, obj) {
    return new Promise((resolve, reject) => {
      const r = tx(store, "readwrite").put(obj);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }

  async function dbDelLocal(store, key) {
    return new Promise((resolve, reject) => {
      const r = tx(store, "readwrite").delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }

  function dbAll(store) {
    return new Promise((resolve, reject) => {
      const r = tx(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  async function loadSettings() {
    const rows = await dbAll("settings");
    const s = {};
    for (const r of rows) s[r.key] = r.value;

    // defaults
    if (!s.quarterlyTargets) s.quarterlyTargets = {};
    if (s.desiredPct == null) s.desiredPct = 0;
    if (s.daysSoon == null) s.daysSoon = 7;

    // supabase settings (optional)
    if (!s.supabaseUrl) s.supabaseUrl = "";
    if (!s.supabaseAnonKey) s.supabaseAnonKey = "";

    return s;
  }

  function saveSetting(key, value) {
    return dbPutLocal("settings", { key, value });
  }

  function getQuarterTarget(settings, qKey) {
    return Number(settings?.quarterlyTargets?.[qKey] || 0);
  }

  /**********************
   * Outbox (sync queue)
   **********************/
  async function outboxAdd(op, store, key, data) {
    const row = { id: uid(), op, store, key, data, createdAt: nowISO() };
    await dbPutLocal("outbox", row);
  }

  async function outboxList() {
    const all = await dbAll("outbox");
    return all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async function outboxRemove(id) {
    await dbDelLocal("outbox", id);
  }

  /**********************
   * Supabase REST
   **********************/
  const SUPA = {
    url: null,
    anon: null,
    session: null, // {access_token, refresh_token, user:{id,email}}
    userId: null,
    profile: null, // profiles row
    roles: [],
    zone: "general",
    activeZone: "general",
    isAdmin: false,
    ready: false,
    lastError: null,
  };

  async function authGet(key) {
    return (await dbGet("auth", key))?.value ?? null;
  }
  async function authSet(key, value) {
    return dbPutLocal("auth", { key, value });
  }

  function supaConfigured(settings) {
    const url = String(settings?.supabaseUrl || "").trim();
    const anon = String(settings?.supabaseAnonKey || "").trim();
    return !!(url && anon);
  }

  function supaHeaders() {
    const h = { apikey: SUPA.anon, "Content-Type": "application/json" };
    if (SUPA.session?.access_token) h["Authorization"] = "Bearer " + SUPA.session.access_token;
    return h;
  }

  async function supaSignIn(email, password) {
    const body = new URLSearchParams({ grant_type: "password", email, password }).toString();
    const r = await fetch(`${SUPA.url}/auth/v1/token`, {
      method: "POST",
      headers: { apikey: SUPA.anon, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error_description || j?.msg || "Login fallido");
    SUPA.session = { access_token: j.access_token, refresh_token: j.refresh_token, user: j.user };
    SUPA.userId = j.user?.id || null;
    await authSet("session", SUPA.session);
    return SUPA.session;
  }

  async function supaSignOut() {
    SUPA.session = null;
    SUPA.userId = null;
    SUPA.profile = null;
    SUPA.roles = [];
    SUPA.isAdmin = false;
    SUPA.zone = "general";
    SUPA.activeZone = "general";
    await authSet("session", null);
  }

  async function supaRefresh() {
    if (!SUPA.session?.refresh_token) return null;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: SUPA.session.refresh_token }).toString();
    const r = await fetch(`${SUPA.url}/auth/v1/token`, {
      method: "POST",
      headers: { apikey: SUPA.anon, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("No se pudo refrescar sesión");
    SUPA.session.access_token = j.access_token;
    SUPA.session.refresh_token = j.refresh_token || SUPA.session.refresh_token;
    SUPA.session.user = j.user || SUPA.session.user;
    SUPA.userId = SUPA.session.user?.id || SUPA.userId;
    await authSet("session", SUPA.session);
    return SUPA.session;
  }

  async function supaRequest(url, opts = {}) {
    let r = await fetch(url, opts);
    if (r.status === 401) {
      try {
        await supaRefresh();
        r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...supaHeaders() } });
      } catch {}
    }
    return r;
  }

  function pgUrl(table, query = "") {
    const q = query ? (query.startsWith("?") ? query : "?" + query) : "";
    return `${SUPA.url}/rest/v1/${table}${q}`;
  }

  // read rows in active zone
  async function supaSelectZone(table) {
    const zone = SUPA.activeZone || SUPA.zone || "general";
    const url = pgUrl(table, `select=zone,id,updated_at,data&zone=eq.${encodeURIComponent(zone)}&order=updated_at.desc`);
    const r = await supaRequest(url, { headers: supaHeaders() });
    const j = await r.json().catch(() => []);
    if (!r.ok) throw new Error(j?.message || "Error leyendo " + table);
    return Array.isArray(j) ? j : [];
  }

  async function supaUpsert(table, obj) {
    const zone = SUPA.activeZone || SUPA.zone || "general";
    const payload = [
      {
        zone,
        id: String(obj.id),
        data: obj,
        updated_at: nowISO(),
      },
    ];
    const url = pgUrl(table, "on_conflict=zone,id");
    const r = await supaRequest(url, {
      method: "POST",
      headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error("Upsert " + table + " falló: " + txt.slice(0, 200));
    }
    return true;
  }

  async function supaDelete(table, id) {
    const zone = SUPA.activeZone || SUPA.zone || "general";
    const url = pgUrl(table, `zone=eq.${encodeURIComponent(zone)}&id=eq.${encodeURIComponent(id)}`);
    const r = await supaRequest(url, { method: "DELETE", headers: supaHeaders() });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error("Delete " + table + " falló: " + txt.slice(0, 200));
    }
    return true;
  }

  async function supaLoadProfile() {
    if (!SUPA.userId) return null;
    const url = pgUrl("profiles", `select=user_id,email,display_name,zone,roles,updated_at&user_id=eq.${encodeURIComponent(SUPA.userId)}`);
    const r = await supaRequest(url, { headers: supaHeaders() });
    const j = await r.json().catch(() => []);
    if (!r.ok) throw new Error("No se pudo cargar profile");
    let p = Array.isArray(j) ? j[0] : null;

    // auto-create profile si no existe
    if (!p) {
      const email = SUPA.session?.user?.email || null;
      const payload = [
        {
          user_id: SUPA.userId,
          email,
          display_name: email ? String(email).split("@")[0] : "usuario",
          zone: "general",
          roles: ["delegado"],
          updated_at: nowISO(),
        },
      ];
      const insUrl = pgUrl("profiles", "on_conflict=user_id");
      const ins = await supaRequest(insUrl, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload),
      });
      const jj = await ins.json().catch(() => []);
      if (!ins.ok) throw new Error("No se pudo crear profile");
      p = Array.isArray(jj) ? jj[0] : payload[0];
    }

    SUPA.profile = p;
    SUPA.roles = Array.isArray(p.roles) ? p.roles : [];
    SUPA.zone = (p.zone || "general").trim() || "general";
    SUPA.isAdmin = SUPA.roles.includes("admin");
    SUPA.activeZone = SUPA.isAdmin ? (SUPA.activeZone || SUPA.zone) : SUPA.zone;

    // toggle admin tab
    const adminTab = document.querySelector('nav .tab[data-view="admin"]');
    if (adminTab) adminTab.style.display = SUPA.isAdmin ? "" : "none";

    // show sync button when configured+logged
    const btnSync = $("#btnSync");
    if (btnSync) btnSync.style.display = SUPA.ready && SUPA.userId ? "inline-flex" : "none";

    return p;
  }

  /**********************
   * Data wrappers (IDB + optional sync)
   **********************/
  const SYNC_STORES = new Set(["farmacias", "opticas", "productos", "pedidos", "visitas", "settings", "misFarmacias", "misOpticas"]);
  async function dbPut(store, obj) {
    await dbPutLocal(store, obj);
    if (SUPA.ready && SUPA.userId && SYNC_STORES.has(store)) {
      try {
        await supaUpsert(store, obj);
      } catch (e) {
        await outboxAdd("put", store, obj?.id, obj);
      }
    } else {
      await outboxAdd("put", store, obj?.id, obj);
    }
    return true;
  }
  async function dbDel(store, key) {
    await dbDelLocal(store, key);
    if (SUPA.ready && SUPA.userId && SYNC_STORES.has(store)) {
      try {
        await supaDelete(store, key);
      } catch (e) {
        await outboxAdd("del", store, key, null);
      }
    } else {
      await outboxAdd("del", store, key, null);
    }
    return true;
  }

  async function outboxProcess(limit = 50) {
    if (!(SUPA.ready && SUPA.userId)) return 0;
    const items = await outboxList();
    let done = 0;
    for (const it of items.slice(0, limit)) {
      try {
        if (!SYNC_STORES.has(it.store)) { await outboxRemove(it.id); continue; }
        if (it.op === "put") await supaUpsert(it.store, it.data);
        if (it.op === "del") await supaDelete(it.store, it.key);
        await outboxRemove(it.id);
        done++;
      } catch (e) {
        // stop on first failure to avoid loops
        break;
      }
    }
    return done;
  }

  async function pullZoneToLocal() {
    if (!(SUPA.ready && SUPA.userId)) return 0;
    const stores = Array.from(SYNC_STORES);
    let n = 0;
    for (const store of stores) {
      // "settings" is shared per zone; OK.
      try {
        const rows = await supaSelectZone(store);
        for (const r of rows) {
          if (r?.data?.id) {
            // last-write-wins overwrite local
            await dbPutLocal(store, r.data);
            n++;
          }
        }
      } catch (e) {
        // ignore per store errors to keep app usable offline
      }
    }
    return n;
  }

  async function fullResync() {
    if (!(SUPA.ready && SUPA.userId)) return;
    toast("Sincronizando…", 1200);
    await outboxProcess(200);
    await pullZoneToLocal();
    await refreshState();
    toast("Sync OK");
  }

  /**********************
   * Business rules
   **********************/
  function normalizeEstado(s) {
    const t = String(s || "").toLowerCase().trim();
    if (t.includes("confirm")) return "confirmado";
    if (t.includes("export")) return "confirmado";
    if (t.includes("enviado")) return "confirmado";
    return "borrador";
  }

  function pedidoTotal(p) {
    return Number(p.total || 0);
  }

  function recomputePedido(p) {
    const lineas = Array.isArray(p.lineas) ? p.lineas : [];
    for (const l of lineas) {
      const cant = Number(l.cantidad || 0);
      const pu = Number(l.precioUnit || 0);
      const dto = Number(l.descuentoPct || 0);
      const base = cant * pu;
      const t = base * (1 - dto / 100);
      l.total = Number.isFinite(t) ? +t.toFixed(2) : 0;
    }
    const tot = lineas.reduce((s, l) => s + Number(l.total || 0), 0);
    p.total = +tot.toFixed(2);
    p.elementos = Math.max(0, Number(p.elementos ?? lineas.length ?? 0));
    return p;
  }

  function getPedidosOk(pedidos) {
    return (pedidos || []).filter((p) => String(p.estado || "") === "confirmado");
  }

  function statsForEntity(entityId, entityType, pedidosOk) {
    const list = (pedidosOk || [])
      .filter((p) => p.entityId === entityId && p.entityType === entityType)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    if (list.length < 3) return { hasEstimate: false, count: list.length };

    const last10 = list.slice(0, 10).sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const diffs = [];
    for (let i = 1; i < last10.length; i++) {
      const d1 = new Date(last10[i - 1].fecha);
      const d2 = new Date(last10[i].fecha);
      const days = (d2 - d1) / (1000 * 60 * 60 * 24);
      if (days > 0 && days < 3650) diffs.push(days);
    }
    const avgDays = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;

    const last = new Date(list[0].fecha);
    const next = avgDays ? new Date(last.getTime() + avgDays * 24 * 60 * 60 * 1000) : null;

    return {
      hasEstimate: !!(avgDays && next),
      avgDays,
      lastISO: list[0].fecha,
      nextISO: next ? next.toISOString() : null,
      count: list.length,
    };
  }

  function mapsLinkForEntity(ent) {
    if (!ent) return "";
    if (ent.lat != null && ent.lon != null) {
      const lat = Number(ent.lat);
      const lon = Number(ent.lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        return `https://www.google.com/maps?q=${encodeURIComponent(lat + "," + lon)}`;
      }
    }
    const addr = (ent.direccion || ent.direccion1 || ent.direccion2 || "").trim();
    if (addr) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
    return "";
  }

  async function ensureProductoGeneral() {
    const all = await dbAll("productos");
    let p = all.find((x) => String(x.nombre || "").trim().toLowerCase() === "general");
    if (p) return p;

    p = { id: uid(), nombre: "General", descripcion: "Importaciones/pedidos rápidos.", creadoEn: nowISO(), actualizadoEn: nowISO() };
    await dbPut("productos", p);
    return p;
  }

  /**********************
   * Mis (farmacias/ópticas)
   **********************/
  async function getMisIds(store, keyName) {
    const all = await dbAll(store);
    return new Set(all.map((x) => x[keyName]));
  }

  async function addToMis(store, keyName, entityId) {
    const all = await dbAll(store);
    if (all.some((x) => x[keyName] === entityId)) return;
    await dbPut(store, { id: uid(), [keyName]: entityId, createdAt: nowISO() });
  }

  async function removeFromMis(store, keyName, entityId) {
    const all = await dbAll(store);
    const row = all.find((x) => x[keyName] === entityId);
    if (row) await dbDel(store, row.id);
  }

  /**********************
   * Imports
   **********************/
  async function upsertFarmaciaFromNewItem(it) {
    const codigo = String(it.codigo || "").trim();
    if (!codigo) return null;

    const id = "F_" + codigo;
    const cur = await dbGet("farmacias", id);

    const f = {
      id,
      codigo,
      nombre: cur?.nombre || it.nombre || `Farmacia ${codigo}`,
      direccion: it.direccion || cur?.direccion || "",
      cp: it.cp || cur?.cp || "",
      concello: it.concello || cur?.concello || "",
      telefono: it.telefono || cur?.telefono || "",
      cliente: it.titular1 || it.cliente || cur?.cliente || "",
      lon: it.lon ?? cur?.lon ?? null,
      lat: it.lat ?? cur?.lat ?? null,
      source: cur?.source || "catalogo",
      createdAt: cur?.createdAt || nowISO(),
      updatedAt: nowISO(),
    };

    await dbPut("farmacias", f);
    return f;
  }

  async function importFarmaciasNewJsonFile(file) {
    const txt = await file.text();
    let obj;
    try {
      obj = JSON.parse(txt);
    } catch {
      toast("JSON inválido");
      return;
    }

    const arr = Array.isArray(obj.data) ? obj.data : [];
    if (!arr.length) {
      toast("No hay data[] en el JSON");
      return;
    }

    let n = 0;
    for (const it of arr) {
      const ok = await upsertFarmaciaFromNewItem(it);
      if (ok) n++;
    }
    toast(`Farmacias importadas/actualizadas: ${n}`);
  }

  function parseKmlDescTable(html) {
    const map = {};
    const div = document.createElement("div");
    div.innerHTML = html || "";
    const tds = div.querySelectorAll("td");
    for (let i = 0; i < tds.length - 1; i += 2) {
      const k = (tds[i].textContent || "").trim().toUpperCase();
      const v = (tds[i + 1].textContent || "").trim();
      if (k) map[k] = v;
    }
    return map;
  }

  async function importFarmaciasFromKmlFile(file) {
    const txt = await file.text();
    const xml = new DOMParser().parseFromString(txt, "text/xml");
    const placemarks = Array.from(xml.getElementsByTagName("Placemark"));

    let n = 0;
    for (const pm of placemarks) {
      const name = pm.getElementsByTagName("name")[0]?.textContent?.trim() || "";
      if (!name) continue;

      const desc = pm.getElementsByTagName("description")[0]?.textContent || "";
      const fields = parseKmlDescTable(desc);

      const coordText = pm.getElementsByTagName("coordinates")[0]?.textContent?.trim() || "";
      let lon = null,
        lat = null;
      if (coordText) {
        const parts = coordText.split(",").map((x) => x.trim());
        lon = parts[0] ? Number(String(parts[0]).replace(",", ".")) : null;
        lat = parts[1] ? Number(String(parts[1]).replace(",", ".")) : null;
      }

      const it = {
        codigo: name,
        direccion: fields["DIRECCION"] || "",
        cp: fields["CODIGOPOST"] || "",
        concello: fields["CONCELLO"] || "",
        telefono: fields["TELEFONO"] || "",
        titular1: fields["TITULAR1"] || "",
        lon,
        lat,
      };

      const ok = await upsertFarmaciaFromNewItem(it);
      if (ok) n++;
    }

    toast(`KML importado: ${n} farmacias`);
  }

  async function importPedidosJsonArray(arr, entityTypeHint = "farmacia") {
    if (!Array.isArray(arr)) {
      toast("El JSON debe ser una lista []");
      return 0;
    }

    const gen = await ensureProductoGeneral();
    let n = 0;

    for (const it of arr) {
      const cliente = String(it.cliente || "").trim();
      const fechaYMD = String(it.fecha || "").trim();
      const total = Number(it.total_eur || it.total || 0);
      const elementos = Number(it.elementos || 0);
      if (!cliente || !fechaYMD) continue;

      // buscar entidad por cliente
      let entity = null;
      let entityType = entityTypeHint === "optica" ? "optica" : "farmacia";
      if (entityType === "farmacia") {
        const list = await dbAll("farmacias");
        entity = list.find((x) => String(x.cliente || "").trim().toLowerCase() === cliente.toLowerCase());
        if (!entity) {
          // crear mínima
          entity = {
            id: uid(),
            codigo: "",
            nombre: `Farmacia ${cliente.split(" ").slice(0, 2).join(" ")}`.trim(),
            direccion: "",
            cp: "",
            concello: "",
            telefono: "",
            cliente,
            lat: null,
            lon: null,
            source: "manual",
            createdAt: nowISO(),
            updatedAt: nowISO(),
          };
          await dbPut("farmacias", entity);
        }
      } else {
        const list = await dbAll("opticas");
        entity = list.find((x) => String(x.cliente || "").trim().toLowerCase() === cliente.toLowerCase());
        if (!entity) {
          entity = {
            id: uid(),
            codigo: "",
            nombre: `Óptica ${cliente.split(" ").slice(0, 2).join(" ")}`.trim(),
            direccion: "",
            ciudad: "",
            telefono: "",
            cliente,
            lat: null,
            lon: null,
            source: "manual",
            createdAt: nowISO(),
            updatedAt: nowISO(),
          };
          await dbPut("opticas", entity);
        }
      }

      const d = parseISODateYMD(fechaYMD);
      if (!d) continue;

      const pedido = recomputePedido({
        id: uid(),
        entityType,
        entityId: entity.id,
        fecha: d.toISOString(),
        estado: normalizeEstado(it.estado),
        elementos,
        notas: `Importado JSON · estado origen: ${it.estado} · elementos: ${elementos}`,
        lineas: [
          { id: uid(), productoId: gen.id, nombre: "General", cantidad: 1, precioUnit: +total.toFixed(2), descuentoPct: 0, total: +total.toFixed(2) },
        ],
        total: +total.toFixed(2),
        creadoEn: nowISO(),
        actualizadoEn: nowISO(),
      });

      await dbPut("pedidos", pedido);
      n++;
    }

    toast(`Pedidos importados: ${n}`);
    return n;
  }

  async function importPedidosJsonFile(file) {
    const txt = await file.text();
    let arr;
    try {
      arr = JSON.parse(txt);
    } catch {
      toast("JSON inválido");
      return;
    }
    await importPedidosJsonArray(arr);
  }

  /**********************
   * Dialog helpers
   **********************/
  const dlgMain = () => $("#dlgMain");
  const dlgSub = () => $("#dlgSub");

  function dlgMainClose() {
    dlgMain()?.close();
  }
  function dlgSubClose() {
    dlgSub()?.close();
  }

  function dlgMainOpen(title, sub, bodyHTML, footHTML = "") {
    $("#dlgMainTitle").textContent = title || "Detalles";
    $("#dlgMainSub").textContent = sub || "";
    $("#dlgMainBody").innerHTML = bodyHTML || "";
    $("#dlgMainFoot").innerHTML = footHTML || "";
    dlgMain()?.showModal();
  }
  function dlgSubOpen(title, sub, bodyHTML, footHTML = "") {
    $("#dlgSubTitle").textContent = title || "Editar";
    $("#dlgSubSub").textContent = sub || "";
    $("#dlgSubBody").innerHTML = bodyHTML || "";
    $("#dlgSubFoot").innerHTML = footHTML || "";
    dlgSub()?.showModal();
  }

  /**********************
   * Help text (data-help)
   **********************/
  function wireHelp(rootEl) {
    const help = rootEl.querySelector("[data-helpbox]");
    const inputs = $$("[data-help]", rootEl);
    for (const inp of inputs) {
      inp.addEventListener("focus", () => {
        if (help) help.innerHTML = `<b>Ayuda:</b> ${escapeHtml(inp.getAttribute("data-help"))}`;
      });
    }
  }

  /**********************
   * App state + router
   **********************/
  const state = {
    view: "dash",
    farmacias: [],
    opticas: [],
    misFarmacias: [],
    misOpticas: [],
    pedidos: [],
    productos: [],
    visitas: [],
    settings: null,
  };

  async function refreshState() {
    state.farmacias = await dbAll("farmacias");
    state.opticas = await dbAll("opticas");
    state.misFarmacias = await dbAll("misFarmacias");
    state.misOpticas = await dbAll("misOpticas");
    state.pedidos = await dbAll("pedidos");
    state.productos = await dbAll("productos");
    state.visitas = await dbAll("visitas");
    state.settings = await loadSettings();
  }

  function setView(v) {
    state.view = v;
    $$("nav .tab").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    render().catch((e) => {
      console.error(e);
      toast("Error render: " + (e?.message || e));
    });
  }

  /**********************
   * Compute due & soon
   **********************/
  function computeDueSoonEntities(entities, entityType, pedidos, daysSoon = 7) {
    const ok = getPedidosOk(pedidos);
    const now = new Date();

    const due = [];
    const soon = [];

    for (const ent of entities) {
      const st = statsForEntity(ent.id, entityType, ok);
      if (!st.hasEstimate) continue;
      const next = st.nextISO ? new Date(st.nextISO) : null;
      if (!next) continue;

      const diff = Math.round((next - now) / (1000 * 60 * 60 * 24));
      const metaText = `Próximo: ${fmtDate(next.toISOString())} · media: ${Math.round(st.avgDays)} días`;

      if (diff < 0) due.push({ ent, entityType, metaText, diff });
      else if (diff <= daysSoon) soon.push({ ent, entityType, metaText, diff });
    }

    due.sort((a, b) => a.diff - b.diff);
    soon.sort((a, b) => a.diff - b.diff);

    return { due, soon };
  }

  function renderSuggestList(items, includeVisit = false) {
    if (!items.length) return `<div class="muted">—</div>`;
    return `
      <div class="list">
        ${items
          .map((x) => {
            const ent = x.ent;
            const title = ent.nombre || ent.codigo || (x.entityType === "optica" ? "Óptica" : "Farmacia");
            const cliente = ent.cliente ? `Cliente: ${ent.cliente}` : "";
            const lugar = x.entityType === "optica" ? (ent.ciudad ? `Ciudad: ${ent.ciudad}` : "") : (ent.concello ? `Concello: ${ent.concello}` : "");
            return `
              <div class="list-item">
                <div>
                  <b>${escapeHtml(title)}</b><br>
                  <span class="mini muted">${escapeHtml(x.metaText)}</span><br>
                  <span class="mini muted">${escapeHtml(cliente)}</span><br>
                  <span class="mini muted">${escapeHtml(lugar)}</span>
                </div>
                <div class="right flex">
                  <button class="btn btn-xs" data-act="maps" data-type="${escapeAttr(x.entityType)}" data-id="${escapeAttr(ent.id)}">Maps</button>
                  ${
                    includeVisit
                      ? `<button class="btn-primary btn-xs" data-act="visit" data-type="${escapeAttr(x.entityType)}" data-id="${escapeAttr(ent.id)}">Visita</button>`
                      : ""
                  }
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  /**********************
   * Views
   **********************/
  async function renderDashboard(viewEl) {
    const { pedidos, settings } = state;

    const now = new Date();
    const qNow = quarterKey(now);

    const target = getQuarterTarget(settings, qNow) || 0;
    const desiredPct = Number(settings.desiredPct || 0);
    const desiredTarget = target * (1 + desiredPct / 100);

    const ok = getPedidosOk(pedidos);
    const qSales = ok
      .filter((p) => quarterKey(new Date(p.fecha)) === qNow)
      .reduce((s, p) => s + pedidoTotal(p), 0);

    const faltan = Math.max(0, target - qSales);
    const faltanDeseado = Math.max(0, desiredTarget - qSales);

    const { end } = quarterBounds(now);
    const daysLeft = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));
    const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));

    const perWeek = weeksLeft ? faltan / weeksLeft : faltan;
    const perDay = daysLeft ? faltan / daysLeft : faltan;

    const perWeekD = weeksLeft ? faltanDeseado / weeksLeft : faltanDeseado;
    const perDayD = daysLeft ? faltanDeseado / daysLeft : faltanDeseado;

    const prog = target ? Math.round((qSales / target) * 100) : 0;
    const progD = desiredTarget ? Math.round((qSales / desiredTarget) * 100) : 0;

    const daysSoon = Math.max(1, Number(settings.daysSoon || 7));

    const misFarmIds = await getMisIds("misFarmacias", "farmaciaId");
    const myFarms = state.farmacias.filter((f) => misFarmIds.has(f.id));
    const { due: fDue, soon: fSoon } = computeDueSoonEntities(myFarms, "farmacia", pedidos, daysSoon);

    const misOptIds = await getMisIds("misOpticas", "opticaId");
    const myOpts = state.opticas.filter((o) => misOptIds.has(o.id));
    const { due: oDue, soon: oSoon } = computeDueSoonEntities(myOpts, "optica", pedidos, daysSoon);

    const dueAll = [...fDue, ...oDue].sort((a, b) => a.diff - b.diff).slice(0, 6);
    const soonAll = [...fSoon, ...oSoon].sort((a, b) => a.diff - b.diff).slice(0, 6);

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Dashboard · ${escapeHtml(qNow)}</h2>
            <div class="mini muted">Zona activa: <b>${escapeHtml(SUPA.activeZone || "general")}</b>${SUPA.isAdmin ? " (admin)" : ""}</div>
          </div>
          <div class="right flex">
            <span class="pill ${SUPA.userId ? "ok" : "warn"}">${SUPA.userId ? "Conectado" : "Offline/Invitado"}</span>
            <button class="btn btn-xs" id="dashLogin">${SUPA.userId ? "Cuenta" : "Login"}</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="kpi">
          <div class="k">
            <div class="v">${fmtEur(qSales)}</div>
            <div class="t">Ventas trimestre</div>
            <div class="mini muted">Progreso: <b>${prog}%</b></div>
          </div>

          <div class="k">
            <div class="v">${fmtEur(target)}</div>
            <div class="t">Objetivo ${escapeHtml(qNow)}</div>
            <div class="mini muted">Faltan: <b>${fmtEur(faltan)}</b></div>
          </div>

          <div class="k">
            <div class="v">${fmtEur(desiredTarget)}</div>
            <div class="t">Objetivo deseado (+${desiredPct}%)</div>
            <div class="mini muted">Faltan: <b>${fmtEur(faltanDeseado)}</b></div>
          </div>

          <div class="k">
            <div class="v">${progD}%</div>
            <div class="t">Progreso deseado</div>
            <div class="mini muted">${daysLeft} días restantes</div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid two">
          <div class="card" style="margin:0">
            <h2>Ritmo recomendado</h2>
            <div class="mini muted">Para llegar al objetivo configurado.</div>
            <div class="hr"></div>
            <div class="grid two">
              <div class="k"><div class="v">${fmtEur(perWeek)}</div><div class="t">por semana</div></div>
              <div class="k"><div class="v">${fmtEur(perDay)}</div><div class="t">por día</div></div>
            </div>
          </div>

          <div class="card" style="margin:0">
            <h2>Ritmo deseado</h2>
            <div class="mini muted">Con +${desiredPct}%.</div>
            <div class="hr"></div>
            <div class="grid two">
              <div class="k"><div class="v">${fmtEur(perWeekD)}</div><div class="t">por semana</div></div>
              <div class="k"><div class="v">${fmtEur(perDayD)}</div><div class="t">por día</div></div>
            </div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid two">
          <div class="card" style="margin:0">
            <h2>Vencidas (${dueAll.length})</h2>
            ${renderSuggestList(dueAll, true)}
          </div>
          <div class="card" style="margin:0">
            <h2>Próximas (≤ ${daysSoon} días) (${soonAll.length})</h2>
            ${renderSuggestList(soonAll, true)}
          </div>
        </div>
      </div>
    `;

    $("#dashLogin").onclick = () => openAuthModal();

    viewEl.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      const type = b.dataset.type;
      if (!act || !id) return;

      if (act === "maps") {
        const ent = type === "optica" ? state.opticas.find((x) => x.id === id) : state.farmacias.find((x) => x.id === id);
        const url = mapsLinkForEntity(ent);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "visit") {
        openVisitaModal(type, id);
      }
    };
  }

  async function renderPredicciones(viewEl) {
    const { settings, pedidos } = state;
    const daysSoon = Math.max(1, Number(settings.daysSoon || 7));

    const misFarmIds = await getMisIds("misFarmacias", "farmaciaId");
    const myFarms = state.farmacias.filter((f) => misFarmIds.has(f.id));
    const { due: fDue, soon: fSoon } = computeDueSoonEntities(myFarms, "farmacia", pedidos, daysSoon);

    const misOptIds = await getMisIds("misOpticas", "opticaId");
    const myOpts = state.opticas.filter((o) => misOptIds.has(o.id));
    const { due: oDue, soon: oSoon } = computeDueSoonEntities(myOpts, "optica", pedidos, daysSoon);

    const dueAll = [...fDue, ...oDue];
    const soonAll = [...fSoon, ...oSoon];

    viewEl.innerHTML = `
      <div class="card">
        <h2>Predicciones</h2>
        <div class="mini muted">Basado en la media de días entre pedidos (mín. 3 confirmados).</div>
        <div class="hr"></div>

        <div class="grid two">
          <div class="card" style="margin:0">
            <h2>Vencidas (${dueAll.length})</h2>
            ${renderSuggestList(dueAll, true)}
          </div>
          <div class="card" style="margin:0">
            <h2>Próximas (≤ ${daysSoon} días) (${soonAll.length})</h2>
            ${renderSuggestList(soonAll, true)}
          </div>
        </div>
      </div>
    `;

    viewEl.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      const type = b.dataset.type;
      if (!act || !id) return;

      if (act === "maps") {
        const ent = type === "optica" ? state.opticas.find((x) => x.id === id) : state.farmacias.find((x) => x.id === id);
        const url = mapsLinkForEntity(ent);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "visit") {
        openVisitaModal(type, id);
      }
    };
  }

  async function renderFarmaciasCatalog(viewEl) {
    const { farmacias } = state;
    const misIds = await getMisIds("misFarmacias", "farmaciaId");

    const catalogo = farmacias
      .filter((f) => (f.source || "") === "catalogo")
      .sort((a, b) => (a.codigo || a.nombre || "").localeCompare(b.codigo || b.nombre || "", "es"));

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Farmacias (Catálogo)</h2>
            <div class="mini muted">Total catálogo: <b>${catalogo.length}</b> · En Mis farmacias: <b>${misIds.size}</b></div>
          </div>
          <div class="right flex">
            <button class="btn btn-xs" id="btnImportJsonNew">Importar JSON (data[])</button>
            <button class="btn btn-xs" id="btnImportKml">Importar KML</button>
            <button class="btn-danger btn-xs" id="btnBorrarCatalogo">Borrar catálogo</button>
          </div>
        </div>

        <div class="hr"></div>

        <label>Buscar</label>
        <input id="catSearch" placeholder="Nombre / código / concello / cliente..." data-help="Busca en el catálogo por nombre, código, concello o cliente (titular)." />

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>
        <div id="catRows"></div>
      </div>
    `;

    function renderCatalogRows() {
      const q = ($("#catSearch").value || "").trim().toLowerCase();
      let arr = catalogo.slice();
      if (q) {
        arr = arr.filter((f) => {
          const blob = `${f.nombre || ""} ${f.codigo || ""} ${f.concello || ""} ${f.cliente || ""}`.toLowerCase();
          return blob.includes(q);
        });
      }

      $("#catRows").innerHTML = `
        <div class="list">
          ${arr
            .slice(0, 300)
            .map((f) => {
              const inMis = misIds.has(f.id);
              const title = f.nombre || f.codigo || "Farmacia";
              return `
                <div class="list-item" style="${inMis ? "border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.06)" : ""}">
                  <div>
                    <b>${escapeHtml(title)}</b><br>
                    <span class="mini muted">Código: ${escapeHtml(f.codigo || "—")}</span><br>
                    <span class="mini muted">Cliente: ${escapeHtml(f.cliente || "—")}</span><br>
                    <span class="mini muted">Concello: ${escapeHtml(f.concello || "—")} · CP ${escapeHtml(f.cp || "—")}</span>
                  </div>
                  <div class="right flex">
                    <button class="btn btn-xs" data-act="maps" data-id="${escapeAttr(f.id)}">Maps</button>
                    ${
                      inMis
                        ? `<span class="pill ok">en Mis farmacias</span>`
                        : `<button class="btn-primary btn-xs" data-act="addmis" data-id="${escapeAttr(f.id)}">Añadir</button>`
                    }
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
        ${arr.length > 300 ? `<div class="mini muted" style="margin-top:10px">Mostrando 300 de ${arr.length} resultados.</div>` : ""}
      `;
    }

    renderCatalogRows();
    $("#catSearch").oninput = renderCatalogRows;
    wireHelp(viewEl);

    $("#btnImportJsonNew").onclick = async () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json,.json";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        await importFarmaciasNewJsonFile(f);
        await refreshState();
        await renderFarmaciasCatalog(viewEl);
      };
      inp.click();
    };

    $("#btnImportKml").onclick = async () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".kml,application/vnd.google-earth.kml+xml,text/xml";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        await importFarmaciasFromKmlFile(f);
        await refreshState();
        await renderFarmaciasCatalog(viewEl);
      };
      inp.click();
    };

    $("#btnBorrarCatalogo").onclick = async () => {
      if (!confirm("¿Borrar catálogo importado? (No borra manuales)")) return;
      const all = await dbAll("farmacias");
      let n = 0;
      for (const f of all) {
        if ((f.source || "") === "catalogo") {
          await dbDel("farmacias", f.id);
          n++;
        }
      }
      toast(`Catálogo borrado: ${n}`);
      await refreshState();
      await renderFarmaciasCatalog(viewEl);
    };

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (!act || !id) return;

      if (act === "maps") {
        const f = state.farmacias.find((x) => x.id === id);
        const url = mapsLinkForEntity(f);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "addmis") {
        await addToMis("misFarmacias", "farmaciaId", id);
        toast("Añadida a Mis farmacias");
        await refreshState();
        await renderFarmaciasCatalog(viewEl);
      }
    };
  }

  async function renderMisFarmacias(viewEl) {
    const misIds = await getMisIds("misFarmacias", "farmaciaId");
    const mis = state.farmacias
      .filter((f) => misIds.has(f.id))
      .sort((a, b) => (a.nombre || a.codigo || "").localeCompare(b.nombre || b.codigo || "", "es"));

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Mis farmacias (${mis.length})</h2>
            <div class="mini muted">Panel de detalles, visitas y pedidos.</div>
          </div>
          <div class="right">
            <button class="btn btn-xs" id="mfNew">+ Alta manual</button>
          </div>
        </div>

        <label>Buscar</label>
        <input id="mfSearch" placeholder="Nombre / código / cliente..." data-help="Busca dentro de Mis farmacias." />

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>
        <div id="mfRows"></div>
      </div>
    `;

    function renderRows() {
      const q = ($("#mfSearch").value || "").trim().toLowerCase();
      let arr = mis.slice();
      if (q) {
        arr = arr.filter((f) => `${f.nombre || ""} ${f.codigo || ""} ${f.cliente || ""}`.toLowerCase().includes(q));
      }

      $("#mfRows").innerHTML = `
        <div class="list">
          ${arr
            .map((f) => {
              const title = f.nombre || f.codigo || "Farmacia";
              return `
                <div class="list-item">
                  <div>
                    <b>${escapeHtml(title)}</b><br>
                    <span class="mini muted">${escapeHtml(f.concello || "—")} · CP ${escapeHtml(f.cp || "—")}</span><br>
                    <span class="mini muted">Cliente: ${escapeHtml(f.cliente || "—")} · Tel: ${escapeHtml(f.telefono || "—")}</span>
                  </div>
                  <div class="right flex">
                    <button class="btn btn-xs" data-act="details" data-id="${escapeAttr(f.id)}">Detalles</button>
                    <button class="btn-primary btn-xs" data-act="visit" data-id="${escapeAttr(f.id)}">Visita</button>
                    <button class="btn btn-xs" data-act="maps" data-id="${escapeAttr(f.id)}">Maps</button>
                    <button class="btn-danger btn-xs" data-act="delmis" data-id="${escapeAttr(f.id)}">Quitar</button>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    }

    renderRows();
    $("#mfSearch").oninput = renderRows;
    wireHelp(viewEl);

    $("#mfNew").onclick = () => openFarmaciaEdit(null);

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (!act || !id) return;

      if (act === "maps") {
        const f = state.farmacias.find((x) => x.id === id);
        const url = mapsLinkForEntity(f);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "details") {
        openEntityDetails("farmacia", id);
      }
      if (act === "visit") {
        openVisitaModal("farmacia", id);
      }
      if (act === "delmis") {
        await removeFromMis("misFarmacias", "farmaciaId", id);
        toast("Quitada de Mis farmacias");
        await refreshState();
        await renderMisFarmacias(viewEl);
      }
    };
  }

  async function renderOpticasCatalog(viewEl) {
    const { opticas } = state;
    const misIds = await getMisIds("misOpticas", "opticaId");

    const catalogo = opticas
      .filter((o) => (o.source || "") === "catalogo")
      .sort((a, b) => (a.codigo || a.nombre || "").localeCompare(b.codigo || b.nombre || "", "es"));

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Ópticas (Catálogo)</h2>
            <div class="mini muted">Total catálogo: <b>${catalogo.length}</b> · En Mis ópticas: <b>${misIds.size}</b></div>
          </div>
          <div class="right flex">
            <button class="btn btn-xs" id="oImpJson">Importar JSON</button>
            <button class="btn-danger btn-xs" id="oDelCat">Borrar catálogo</button>
          </div>
        </div>

        <label>Buscar</label>
        <input id="oSearch" placeholder="Nombre / código / ciudad / cliente..." data-help="Busca en el catálogo de ópticas." />

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>
        <div id="oRows"></div>
      </div>
    `;

    function renderRows() {
      const q = ($("#oSearch").value || "").trim().toLowerCase();
      let arr = catalogo.slice();
      if (q) {
        arr = arr.filter((o) => `${o.nombre || ""} ${o.codigo || ""} ${o.ciudad || ""} ${o.cliente || ""}`.toLowerCase().includes(q));
      }

      $("#oRows").innerHTML = `
        <div class="list">
          ${arr
            .slice(0, 300)
            .map((o) => {
              const inMis = misIds.has(o.id);
              const title = o.nombre || o.codigo || "Óptica";
              return `
                <div class="list-item" style="${inMis ? "border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.06)" : ""}">
                  <div>
                    <b>${escapeHtml(title)}</b><br>
                    <span class="mini muted">Código: ${escapeHtml(o.codigo || "—")}</span><br>
                    <span class="mini muted">Cliente: ${escapeHtml(o.cliente || "—")}</span><br>
                    <span class="mini muted">Ciudad: ${escapeHtml(o.ciudad || "—")}</span>
                  </div>
                  <div class="right flex">
                    <button class="btn btn-xs" data-act="maps" data-id="${escapeAttr(o.id)}">Maps</button>
                    ${
                      inMis
                        ? `<span class="pill ok">en Mis ópticas</span>`
                        : `<button class="btn-primary btn-xs" data-act="addmis" data-id="${escapeAttr(o.id)}">Añadir</button>`
                    }
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
        ${arr.length > 300 ? `<div class="mini muted" style="margin-top:10px">Mostrando 300 de ${arr.length} resultados.</div>` : ""}
      `;
    }

    renderRows();
    $("#oSearch").oninput = renderRows;
    wireHelp(viewEl);

    $("#oImpJson").onclick = async () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json,.json";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        const txt = await f.text();
        let obj;
        try { obj = JSON.parse(txt); } catch { toast("JSON inválido"); return; }
        const arr = Array.isArray(obj.data) ? obj.data : (Array.isArray(obj) ? obj : []);
        let n = 0;
        for (const it of arr) {
          const codigo = String(it.codigo || it.code || "").trim();
          if (!codigo) continue;
          const id = "O_" + codigo;
          const cur = await dbGet("opticas", id);
          const o = {
            id,
            codigo,
            nombre: cur?.nombre || it.nombre || `Óptica ${codigo}`,
            direccion: it.direccion || cur?.direccion || "",
            ciudad: it.ciudad || it.localidad || cur?.ciudad || "",
            telefono: it.telefono || cur?.telefono || "",
            cliente: it.titular1 || it.cliente || cur?.cliente || "",
            lon: it.lon ?? cur?.lon ?? null,
            lat: it.lat ?? cur?.lat ?? null,
            source: cur?.source || "catalogo",
            createdAt: cur?.createdAt || nowISO(),
            updatedAt: nowISO(),
          };
          await dbPut("opticas", o);
          n++;
        }
        toast(`Ópticas importadas/actualizadas: ${n}`);
        await refreshState();
        await renderOpticasCatalog(viewEl);
      };
      inp.click();
    };

    $("#oDelCat").onclick = async () => {
      if (!confirm("¿Borrar catálogo importado de ópticas?")) return;
      const all = await dbAll("opticas");
      let n = 0;
      for (const o of all) {
        if ((o.source || "") === "catalogo") {
          await dbDel("opticas", o.id);
          n++;
        }
      }
      toast(`Catálogo borrado: ${n}`);
      await refreshState();
      await renderOpticasCatalog(viewEl);
    };

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (!act || !id) return;

      if (act === "maps") {
        const o = state.opticas.find((x) => x.id === id);
        const url = mapsLinkForEntity(o);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "addmis") {
        await addToMis("misOpticas", "opticaId", id);
        toast("Añadida a Mis ópticas");
        await refreshState();
        await renderOpticasCatalog(viewEl);
      }
    };
  }

  async function renderMisOpticas(viewEl) {
    const misIds = await getMisIds("misOpticas", "opticaId");
    const mis = state.opticas
      .filter((o) => misIds.has(o.id))
      .sort((a, b) => (a.nombre || a.codigo || "").localeCompare(b.nombre || b.codigo || "", "es"));

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Mis ópticas (${mis.length})</h2>
            <div class="mini muted">Panel de detalles, visitas y pedidos.</div>
          </div>
          <div class="right">
            <button class="btn btn-xs" id="moNew">+ Alta manual</button>
          </div>
        </div>

        <label>Buscar</label>
        <input id="moSearch" placeholder="Nombre / código / cliente..." data-help="Busca dentro de Mis ópticas." />

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>
        <div id="moRows"></div>
      </div>
    `;

    function renderRows() {
      const q = ($("#moSearch").value || "").trim().toLowerCase();
      let arr = mis.slice();
      if (q) {
        arr = arr.filter((o) => `${o.nombre || ""} ${o.codigo || ""} ${o.cliente || ""}`.toLowerCase().includes(q));
      }

      $("#moRows").innerHTML = `
        <div class="list">
          ${arr
            .map((o) => {
              const title = o.nombre || o.codigo || "Óptica";
              return `
                <div class="list-item">
                  <div>
                    <b>${escapeHtml(title)}</b><br>
                    <span class="mini muted">${escapeHtml(o.ciudad || "—")}</span><br>
                    <span class="mini muted">Cliente: ${escapeHtml(o.cliente || "—")} · Tel: ${escapeHtml(o.telefono || "—")}</span>
                  </div>
                  <div class="right flex">
                    <button class="btn btn-xs" data-act="details" data-id="${escapeAttr(o.id)}">Detalles</button>
                    <button class="btn-primary btn-xs" data-act="visit" data-id="${escapeAttr(o.id)}">Visita</button>
                    <button class="btn btn-xs" data-act="maps" data-id="${escapeAttr(o.id)}">Maps</button>
                    <button class="btn-danger btn-xs" data-act="delmis" data-id="${escapeAttr(o.id)}">Quitar</button>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    }

    renderRows();
    $("#moSearch").oninput = renderRows;
    wireHelp(viewEl);

    $("#moNew").onclick = () => openOpticaEdit(null);

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (!act || !id) return;

      if (act === "maps") {
        const o = state.opticas.find((x) => x.id === id);
        const url = mapsLinkForEntity(o);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "details") {
        openEntityDetails("optica", id);
      }
      if (act === "visit") {
        openVisitaModal("optica", id);
      }
      if (act === "delmis") {
        await removeFromMis("misOpticas", "opticaId", id);
        toast("Quitada de Mis ópticas");
        await refreshState();
        await renderMisOpticas(viewEl);
      }
    };
  }

  async function renderProductos(viewEl) {
    const { productos } = state;
    const arr = [...productos].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Productos (${arr.length})</h2>
            <div class="mini muted">Catálogo interno. Importaciones usan “General”.</div>
          </div>
          <div class="right">
            <button class="btn-primary btn-xs" id="pNew">+ Nuevo</button>
          </div>
        </div>

        <label>Buscar</label>
        <input id="pSearch" placeholder="Nombre / descripción..." data-help="Filtra productos por texto." />

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>
        <div id="pRows"></div>
      </div>
    `;

    function renderRows() {
      const q = ($("#pSearch").value || "").trim().toLowerCase();
      let list = arr.slice();
      if (q) list = list.filter((p) => `${p.nombre || ""} ${p.descripcion || ""}`.toLowerCase().includes(q));

      $("#pRows").innerHTML = `
        <div class="list">
          ${list
            .map((p) => {
              return `
                <div class="list-item">
                  <div>
                    <b>${escapeHtml(p.nombre || "—")}</b><br>
                    <span class="mini muted">${escapeHtml(p.descripcion || "")}</span>
                  </div>
                  <div class="right flex">
                    <button class="btn btn-xs" data-act="edit" data-id="${escapeAttr(p.id)}">Editar</button>
                    <button class="btn-danger btn-xs" data-act="del" data-id="${escapeAttr(p.id)}">Borrar</button>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    }

    renderRows();
    $("#pSearch").oninput = renderRows;
    wireHelp(viewEl);

    $("#pNew").onclick = () => openProductoEdit(null);

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (!act || !id) return;

      if (act === "del") {
        if (!confirm("¿Borrar producto?")) return;
        await dbDel("productos", id);
        toast("Producto borrado");
        await refreshState();
        await renderProductos(viewEl);
      }
      if (act === "edit") openProductoEdit(id);
    };
  }

  async function renderPedidos(viewEl) {
    const { pedidos, farmacias, opticas } = state;

    const misFarmIds = await getMisIds("misFarmacias", "farmaciaId");
    const misOptIds = await getMisIds("misOpticas", "opticaId");

    const farmById = new Map(farmacias.map((f) => [f.id, f]));
    const optById = new Map(opticas.map((o) => [o.id, o]));

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Pedidos (${pedidos.length})</h2>
            <div class="mini muted">Puedes filtrar por tipo, entidad y por “mis”.</div>
          </div>
          <div class="right flex">
            <button class="btn btn-xs" id="oImportFile">Importar JSON</button>
            <button class="btn btn-xs" id="oImportPaste">Pegar JSON</button>
            <button class="btn-primary btn-xs" id="oNew">+ Nuevo</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid two">
          <div>
            <label>Tipo</label>
            <select id="oTipo" data-help="Elige si quieres ver pedidos de farmacias u ópticas.">
              <option value="">Todos</option>
              <option value="farmacia">Farmacias</option>
              <option value="optica">Ópticas</option>
            </select>
          </div>
          <div>
            <label>Solo mis entidades</label>
            <select id="oOnlyMine" data-help="Filtra a pedidos cuyas entidades estén en “Mis farmacias” / “Mis ópticas”.">
              <option value="">No</option>
              <option value="1">Sí</option>
            </select>
          </div>
        </div>

        <label>Buscar (cliente/nombre)</label>
        <input id="oSearch" placeholder="Escribe parte del cliente o nombre..." data-help="Filtra por el cliente o el nombre comercial." />

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>

        <div id="oSummary" class="mini muted"></div>

        <div class="hr"></div>

        <div style="overflow:auto">
          <table>
            <thead>
              <tr>
                <th style="width:120px">Fecha</th>
                <th style="width:90px">Tipo</th>
                <th>Entidad</th>
                <th>Cliente</th>
                <th style="width:110px">Estado</th>
                <th style="width:130px">Total</th>
                <th style="width:170px"></th>
              </tr>
            </thead>
            <tbody id="oRows"></tbody>
          </table>
        </div>
      </div>
    `;

    function entForPedido(p) {
      if (p.entityType === "optica") return optById.get(p.entityId);
      return farmById.get(p.entityId);
    }

    function renderRows() {
      const tipo = ($("#oTipo").value || "").trim();
      const onlyMine = ($("#oOnlyMine").value || "").trim() === "1";
      const q = ($("#oSearch").value || "").trim().toLowerCase();

      let arr = pedidos.slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      if (tipo) arr = arr.filter((p) => p.entityType === tipo);

      if (onlyMine) {
        arr = arr.filter((p) => {
          if (p.entityType === "farmacia") return misFarmIds.has(p.entityId);
          if (p.entityType === "optica") return misOptIds.has(p.entityId);
          return false;
        });
      }

      if (q) {
        arr = arr.filter((p) => {
          const ent = entForPedido(p);
          const blob = `${ent?.nombre || ""} ${ent?.codigo || ""} ${ent?.cliente || ""}`.toLowerCase();
          return blob.includes(q);
        });
      }

      const tot = arr.reduce((s, p) => s + Number(p.total || 0), 0);
      const ok = getPedidosOk(arr);
      const totOk = ok.reduce((s, p) => s + Number(p.total || 0), 0);

      $("#oSummary").innerHTML = `Total listado: <b>${fmtEur(tot)}</b> · Confirmados: <b>${fmtEur(totOk)}</b> · Registros: <b>${arr.length}</b>`;

      $("#oRows").innerHTML = arr
        .map((p) => {
          const ent = entForPedido(p);
          const name = ent ? ent.nombre || ent.codigo || "—" : "—";
          const cli = ent?.cliente || "—";
          return `
            <tr>
              <td>${escapeHtml(fmtDate(p.fecha))}</td>
              <td><span class="pill">${escapeHtml(p.entityType || "—")}</span></td>
              <td>${escapeHtml(name)}</td>
              <td>${escapeHtml(cli)}</td>
              <td><span class="pill ${p.estado === "confirmado" ? "ok" : "warn"}">${escapeHtml(p.estado || "—")}</span></td>
              <td><b>${fmtEur(p.total || 0)}</b></td>
              <td class="right">
                <button class="btn btn-xs" data-act="edit" data-id="${escapeAttr(p.id)}">Editar</button>
                <button class="btn-danger btn-xs" data-act="del" data-id="${escapeAttr(p.id)}">Borrar</button>
              </td>
            </tr>
          `;
        })
        .join("");
    }

    renderRows();
    $("#oTipo").onchange = renderRows;
    $("#oOnlyMine").onchange = renderRows;
    $("#oSearch").oninput = renderRows;
    wireHelp(viewEl);

    $("#oNew").onclick = () => openPedidoEdit(null);

    $("#oImportFile").onclick = async () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json,.json";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        await importPedidosJsonFile(f);
        await refreshState();
        await renderPedidos(viewEl);
      };
      inp.click();
    };

    $("#oImportPaste").onclick = () => openImportPastePedidos();

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (!act || !id) return;

      if (act === "del") {
        if (!confirm("¿Borrar pedido?")) return;
        await dbDel("pedidos", id);
        toast("Pedido borrado");
        await refreshState();
        await renderPedidos(viewEl);
      }
      if (act === "edit") openPedidoEdit(id);
    };
  }

  async function renderRutas(viewEl) {
    const { pedidos, settings } = state;
    const daysSoon = Math.max(1, Number(settings.daysSoon || 7));

    const misFarmIds = await getMisIds("misFarmacias", "farmaciaId");
    const myFarms = state.farmacias.filter((f) => misFarmIds.has(f.id));
    const { due: fDue, soon: fSoon } = computeDueSoonEntities(myFarms, "farmacia", pedidos, daysSoon);

    const misOptIds = await getMisIds("misOpticas", "opticaId");
    const myOpts = state.opticas.filter((o) => misOptIds.has(o.id));
    const { due: oDue, soon: oSoon } = computeDueSoonEntities(myOpts, "optica", pedidos, daysSoon);

    const list = [...fDue, ...oDue, ...fSoon, ...oSoon].sort((a, b) => a.diff - b.diff);

    // agrupar por "hoy" (vencidas primero, luego proximas)
    viewEl.innerHTML = `
      <div class="card">
        <h2>Rutas sugeridas</h2>
        <div class="mini muted">Prioridad: vencidas primero, luego próximas (≤ ${daysSoon} días).</div>
        <div class="hr"></div>

        ${list.length ? renderSuggestList(list, true) : `<div class="muted">—</div>`}
      </div>
    `;

    viewEl.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const id = b.dataset.id;
      const type = b.dataset.type;
      if (!act || !id) return;

      if (act === "maps") {
        const ent = type === "optica" ? state.opticas.find((x) => x.id === id) : state.farmacias.find((x) => x.id === id);
        const url = mapsLinkForEntity(ent);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "visit") openVisitaModal(type, id);
    };
  }

  async function renderVisitas(viewEl) {
    const { visitas } = state;
    const day = $("#visDayPick")?.value || todayYMD();
    const curDay = day;

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Visitas</h2>
            <div class="mini muted">Registro por día (farmacias y ópticas).</div>
          </div>
          <div class="right">
            <button class="btn btn-xs" id="vNew">+ Nueva visita</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid two">
          <div>
            <label>Día</label>
            <input id="visDayPick" type="date" value="${escapeAttr(curDay)}" data-help="Selecciona el día para listar visitas." />
          </div>
          <div>
            <label>Buscar</label>
            <input id="visSearch" placeholder="Entidad / cliente / notas..." data-help="Filtra visitas por texto." />
          </div>
        </div>

        <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>

        <div class="hr"></div>
        <div id="visRows"></div>
      </div>
    `;

    const farmById = new Map(state.farmacias.map((f) => [f.id, f]));
    const optById = new Map(state.opticas.map((o) => [o.id, o]));

    function entFor(v) {
      return v.entityType === "optica" ? optById.get(v.entityId) : farmById.get(v.entityId);
    }

    function renderRows() {
      const day = ($("#visDayPick").value || todayYMD()).trim();
      const q = ($("#visSearch").value || "").trim().toLowerCase();

      let arr = visitas.filter((v) => v.day === day).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      if (q) {
        arr = arr.filter((v) => {
          const ent = entFor(v);
          const blob = `${ent?.nombre || ""} ${ent?.cliente || ""} ${ent?.codigo || ""} ${v.notas || ""}`.toLowerCase();
          return blob.includes(q);
        });
      }

      $("#visRows").innerHTML = `
        <div class="list">
          ${arr
            .map((v) => {
              const ent = entFor(v);
              const title = ent ? ent.nombre || ent.codigo || "—" : "—";
              const meta = ent ? (v.entityType === "optica" ? ent.ciudad || "—" : ent.concello || "—") : "—";
              return `
                <div class="list-item">
                  <div>
                    <b>${escapeHtml(title)}</b> <span class="pill">${escapeHtml(v.entityType)}</span><br>
                    <span class="mini muted">${escapeHtml(fmtDate(v.fecha))} · ${escapeHtml(meta)} · Cliente: ${escapeHtml(ent?.cliente || "—")}</span><br>
                    <span class="mini muted">${escapeHtml(v.notas || "")}</span>
                  </div>
                  <div class="right flex">
                    <button class="btn btn-xs" data-act="maps" data-id="${escapeAttr(v.entityId)}" data-type="${escapeAttr(v.entityType)}">Maps</button>
                    <button class="btn-danger btn-xs" data-act="del" data-id="${escapeAttr(v.id)}">Borrar</button>
                  </div>
                </div>
              `;
            })
            .join("") || `<div class="muted">—</div>`}
        </div>
      `;
    }

    renderRows();
    $("#visDayPick").onchange = renderRows;
    $("#visSearch").oninput = renderRows;
    wireHelp(viewEl);

    $("#vNew").onclick = () => openVisitaModal(null, null);

    viewEl.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;

      if (act === "maps") {
        const id = b.dataset.id;
        const type = b.dataset.type;
        const ent = type === "optica" ? state.opticas.find((x) => x.id === id) : state.farmacias.find((x) => x.id === id);
        const url = mapsLinkForEntity(ent);
        if (url) window.open(url, "_blank", "noopener");
      }
      if (act === "del") {
        const id = b.dataset.id;
        if (!confirm("¿Borrar visita?")) return;
        await dbDel("visitas", id);
        toast("Visita borrada");
        await refreshState();
        await renderVisitas(viewEl);
      }
    };
  }

  async function renderBackup(viewEl) {
    const isAdmin = !!SUPA.isAdmin;

    viewEl.innerHTML = `
      <div class="card">
        <h2>Backup</h2>
        <div class="mini muted">Exporta o restaura todos los datos de la zona activa.</div>
        <div class="hr"></div>

        <div class="grid two">
          <div class="card" style="margin:0">
            <h2>Exportar</h2>
            <div class="mini muted">Genera un JSON con toda la base local (zona activa).</div>
            <div class="hr"></div>
            <button class="btn-primary" id="bExport">Exportar JSON</button>
          </div>

          <div class="card" style="margin:0">
            <h2>Importar</h2>
            <div class="mini muted">${isAdmin ? "Solo admin." : "Necesitas rol admin para importar."}</div>
            <div class="hr"></div>
            <button class="btn" id="bImport" ${isAdmin ? "" : "disabled"}>Importar JSON</button>
            <div class="mini muted" style="margin-top:10px">⚠️ Importar sobrescribe por clave (id).</div>
          </div>
        </div>
      </div>
    `;

    $("#bExport").onclick = async () => {
      const payload = {
        exportedAt: nowISO(),
        zone: SUPA.activeZone || SUPA.zone || "general",
        version: 1,
        farmacias: await dbAll("farmacias"),
        misFarmacias: await dbAll("misFarmacias"),
        opticas: await dbAll("opticas"),
        misOpticas: await dbAll("misOpticas"),
        productos: await dbAll("productos"),
        pedidos: await dbAll("pedidos"),
        visitas: await dbAll("visitas"),
        settings: await dbAll("settings"),
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `backup_ventas_${payload.zone}_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Backup exportado");
    };

    $("#bImport").onclick = async () => {
      if (!SUPA.isAdmin) return;
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json,.json";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        const txt = await f.text();
        let obj;
        try {
          obj = JSON.parse(txt);
        } catch {
          toast("JSON inválido");
          return;
        }

        const putAll = async (store, arr) => {
          if (!Array.isArray(arr)) return;
          for (const x of arr) await dbPut(store, x);
        };

        await putAll("farmacias", obj.farmacias);
        await putAll("misFarmacias", obj.misFarmacias);
        await putAll("opticas", obj.opticas);
        await putAll("misOpticas", obj.misOpticas);
        await putAll("productos", obj.productos);
        await putAll("pedidos", obj.pedidos);
        await putAll("visitas", obj.visitas);
        await putAll("settings", obj.settings);

        toast("Backup importado");
        await refreshState();
        render();
        // push to supabase if logged
        if (SUPA.ready && SUPA.userId) await fullResync();
      };
      inp.click();
    };
  }

  async function renderAjustes(viewEl) {
    const settings = state.settings;
    const now = new Date();
    const y2 = String(now.getFullYear()).slice(-2);
    const keys = ["1T", "2T", "3T", "4T"].map((q) => q + y2);
    const qNow = quarterKey(now);

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Ajustes</h2>
            <div class="mini muted">Objetivos + Supabase + zona.</div>
          </div>
          <div class="right flex">
            <span class="pill">${escapeHtml(SUPA.activeZone || "general")}</span>
          </div>
        </div>

        <div class="hr"></div>

        <form id="prefsForm">
          <h2>Objetivos por trimestre (${y2})</h2>
          <div class="mini muted">Ej: 1T${y2} → 180000</div>

          <div class="grid two">
            ${keys
              .map((k) => {
                const val = Number(settings.quarterlyTargets?.[k] || 0);
                return `
                  <div>
                    <label>${escapeHtml(k)} (objetivo)</label>
                    <input name="qt_${escapeAttr(k)}" type="number" min="0" step="100" value="${escapeAttr(val)}"
                      data-help="Objetivo total de ventas para ${k}." />
                  </div>
                `;
              })
              .join("")}
          </div>

          <div class="hr"></div>

          <h2>Predicciones</h2>
          <label>Días para “próximas”</label>
          <input name="daysSoon" type="number" min="1" step="1" value="${escapeAttr(Number(settings.daysSoon || 7))}"
            data-help="Umbral de días para considerar “próximas”." />

          <label>% extra sobre objetivo</label>
          <input name="desiredPct" type="number" min="0" step="0.5" value="${escapeAttr(Number(settings.desiredPct || 0))}"
            data-help="Objetivo deseado adicional (objetivo × (1 + %/100))." />

          <div class="hr"></div>

          <h2>Supabase</h2>
          <label>Supabase URL</label>
          <input name="supabaseUrl" value="${escapeAttr(settings.supabaseUrl || "")}" placeholder="https://xxxx.supabase.co"
            data-help="URL del proyecto Supabase." />

          <label>Supabase Anon Key</label>
          <textarea name="supabaseAnonKey" placeholder="eyJhbGciOi..." data-help="Anon key del proyecto.">${escapeHtml(settings.supabaseAnonKey || "")}</textarea>

          <div class="hr"></div>

          <div class="right flex">
            <button class="btn" type="button" id="testSupa">Probar</button>
            <button class="btn-primary" type="submit">Guardar</button>
          </div>

          <div class="helpbox mini muted" data-helpbox>Selecciona un campo para ver ayuda.</div>
        </form>

        <div class="hr"></div>

        <div class="mini muted">
          Trimestre actual: <b>${escapeHtml(qNow)}</b> · Objetivo: <b>${fmtEur(getQuarterTarget(settings, qNow))}</b>
        </div>
      </div>
    `;

    wireHelp(viewEl);

    $("#testSupa").onclick = async () => {
      const s = await loadSettings();
      if (!supaConfigured(s)) { toast("Falta URL o Anon Key"); return; }
      SUPA.url = String(s.supabaseUrl).trim();
      SUPA.anon = String(s.supabaseAnonKey).trim();
      try {
        const health = await fetch(`${SUPA.url}/rest/v1/`, { headers: { apikey: SUPA.anon } });
        toast(health.ok ? "Supabase OK" : "Supabase responde, revisa claves");
      } catch (e) {
        toast("No conecta con Supabase");
      }
    };

    $("#prefsForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;

      const qt = { ...(settings.quarterlyTargets || {}) };
      for (const k of keys) {
        const inp = f[`qt_${k}`];
        const v = Math.max(0, Number(inp.value || 0));
        qt[k] = v;
      }
      const desiredPct = Math.max(0, Number(f.desiredPct.value || 0));
      const daysSoon = Math.max(1, Number(f.daysSoon.value || 7));
      const supabaseUrl = String(f.supabaseUrl.value || "").trim();
      const supabaseAnonKey = String(f.supabaseAnonKey.value || "").trim();

      // solo admin puede cambiar ajustes si hay login, si no, permitido local
      if (SUPA.userId && !SUPA.isAdmin) {
        toast("Solo admin puede editar ajustes");
        return;
      }

      await saveSetting("quarterlyTargets", qt);
      await saveSetting("desiredPct", desiredPct);
      await saveSetting("daysSoon", daysSoon);
      await saveSetting("supabaseUrl", supabaseUrl);
      await saveSetting("supabaseAnonKey", supabaseAnonKey);

      toast("Ajustes guardados");
      await refreshState();
      await bootSupabase(); // re-init
      render();
    };
  }

  async function renderAdmin(viewEl) {
    if (!SUPA.userId) {
      viewEl.innerHTML = `<div class="card"><h2>Admin</h2><div class="muted">Inicia sesión para continuar.</div></div>`;
      return;
    }
    if (!SUPA.isAdmin) {
      viewEl.innerHTML = `<div class="card"><h2>Admin</h2><div class="muted">No tienes permisos.</div></div>`;
      return;
    }

    // cargar profiles de la zona? admin ve todos
    const url = pgUrl("profiles", "select=user_id,email,display_name,zone,roles,updated_at&order=email.asc");
    const r = await supaRequest(url, { headers: supaHeaders() });
    const data = await r.json().catch(() => []);
    const profiles = Array.isArray(data) ? data : [];

    const zones = Array.from(new Set(profiles.map((p) => (p.zone || "general").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "es"));
    if (!zones.includes(SUPA.activeZone)) zones.unshift(SUPA.activeZone);

    viewEl.innerHTML = `
      <div class="card">
        <div class="row">
          <div>
            <h2>Admin</h2>
            <div class="mini muted">Gestiona usuarios (roles + zona). La creación de usuarios se hace en Supabase Auth.</div>
          </div>
          <div class="right flex">
            <button class="btn btn-xs" id="admReload">Recargar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid two">
          <div>
            <label>Zona activa (datos)</label>
            <select id="admZone">
              ${zones.map((z) => `<option value="${escapeAttr(z)}"${z === SUPA.activeZone ? " selected" : ""}>${escapeHtml(z)}</option>`).join("")}
            </select>
            <div class="mini muted" style="margin-top:8px">Tu zona: <b>${escapeHtml(SUPA.zone || "general")}</b></div>
          </div>
          <div>
            <label>Crear usuario</label>
            <div class="mini muted">Ve a Supabase → Authentication → Users. Luego aquí asigna roles y zona.</div>
          </div>
        </div>

        <div class="hr"></div>

        <h2>Usuarios (${profiles.length})</h2>
        <div style="overflow:auto">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Nombre</th>
                <th style="width:160px">Zona</th>
                <th style="width:240px">Roles</th>
                <th style="width:140px"></th>
              </tr>
            </thead>
            <tbody>
              ${profiles
                .map((p) => {
                  const roles = Array.isArray(p.roles) ? p.roles : [];
                  return `
                    <tr>
                      <td>${escapeHtml(p.email || "—")}</td>
                      <td><input class="admName" data-uid="${escapeAttr(p.user_id)}" value="${escapeAttr(p.display_name || "")}" /></td>
                      <td><input class="admZoneInp" data-uid="${escapeAttr(p.user_id)}" value="${escapeAttr(p.zone || "general")}" /></td>
                      <td>
                        <label class="mini"><input type="checkbox" class="admRole" data-role="delegado" data-uid="${escapeAttr(p.user_id)}"${roles.includes("delegado") ? " checked" : ""}/> delegado</label>
                        &nbsp;&nbsp;
                        <label class="mini"><input type="checkbox" class="admRole" data-role="admin" data-uid="${escapeAttr(p.user_id)}"${roles.includes("admin") ? " checked" : ""}/> admin</label>
                      </td>
                      <td class="right"><button class="btn btn-xs" data-act="saveProfile" data-uid="${escapeAttr(p.user_id)}">Guardar</button></td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    $("#admReload").onclick = () => renderAdmin(viewEl);

    $("#admZone").onchange = async () => {
      SUPA.activeZone = ($("#admZone").value || SUPA.zone || "general").trim() || "general";
      toast("Zona activa: " + SUPA.activeZone);
      await fullResync();
      render();
    };

    viewEl.onclick = async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.dataset.act !== "saveProfile") return;
      const uid = btn.dataset.uid;

      const zone = (viewEl.querySelector(`.admZoneInp[data-uid="${CSS.escape(uid)}"]`)?.value || "general").trim() || "general";
      const display_name = (viewEl.querySelector(`.admName[data-uid="${CSS.escape(uid)}"]`)?.value || "").trim();
      const roles = Array.from(viewEl.querySelectorAll(`.admRole[data-uid="${CSS.escape(uid)}"]`))
        .filter((ch) => ch.checked)
        .map((ch) => ch.dataset.role);

      const payload = [{ user_id: uid, zone, roles, display_name, updated_at: nowISO() }];
      const u = pgUrl("profiles", "on_conflict=user_id");
      const rr = await supaRequest(u, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload),
      });
      if (!rr.ok) {
        toast("Error guardando");
        return;
      }
      toast("Perfil actualizado");
      await supaLoadProfile();
      await refreshState();
      render();
    };
  }

  /**********************
   * Dialog flows: auth
   **********************/
  function openAuthModal() {
    const logged = !!SUPA.userId;
    dlgMainOpen(
      logged ? "Cuenta" : "Login",
      logged ? (SUPA.session?.user?.email || "") : "Conecta Supabase para sincronizar.",
      `
        ${logged ? `
          <div class="mini muted">Usuario: <b>${escapeHtml(SUPA.session?.user?.email || "—")}</b></div>
          <div class="mini muted">Roles: <b>${escapeHtml((SUPA.roles||[]).join(", ") || "—")}</b></div>
          <div class="mini muted">Zona: <b>${escapeHtml(SUPA.zone || "general")}</b></div>
          <div class="mini muted">Zona activa: <b>${escapeHtml(SUPA.activeZone || "general")}</b></div>
          <div class="hr"></div>
          <button class="btn" id="accSync">Sincronizar</button>
          <button class="btn-danger" id="accLogout">Cerrar sesión</button>
        ` : `
          <label>Email</label>
          <input id="authEmail" placeholder="marta@tu-dominio.com" />
          <label>Contraseña</label>
          <input id="authPass" type="password" placeholder="••••••••" />
          <div class="hr"></div>
          <div class="mini muted">Si no te deja entrar, revisa que el usuario exista en Supabase Auth y tenga perfil en tabla <b>profiles</b>.</div>
        `}
      `,
      `
        <div class="row">
          <div class="mini muted">${SUPA.ready ? "Supabase configurado" : "Supabase no configurado"}</div>
          <div class="right flex">
            <button class="btn" id="authCancel">Cerrar</button>
            ${logged ? "" : `<button class="btn-primary" id="authLogin">Entrar</button>`}
          </div>
        </div>
      `
    );

    $("#authCancel").onclick = () => dlgMainClose();

    if (logged) {
      $("#accLogout").onclick = async () => {
        await supaSignOut();
        toast("Sesión cerrada");
        dlgMainClose();
        await refreshState();
        render();
      };
      $("#accSync").onclick = async () => {
        dlgMainClose();
        await fullResync();
      };
      return;
    }

    $("#authLogin").onclick = async () => {
      const email = ($("#authEmail").value || "").trim();
      const pass = ($("#authPass").value || "").trim();
      if (!email || !pass) {
        toast("Email y contraseña");
        return;
      }
      try {
        await supaSignIn(email, pass);
        await supaLoadProfile();
        toast("Login OK");
        dlgMainClose();
        await fullResync();
        render();
      } catch (e) {
        toast(e?.message || "Login fallido");
      }
    };
  }

  /**********************
   * Dialog flows: entity edit/details
   **********************/
  async function openFarmaciaEdit(id) {
    const isNew = !id;
    const f = isNew
      ? { id: uid(), codigo: "", nombre: "", direccion: "", cp: "", concello: "", telefono: "", cliente: "", lat: null, lon: null, source: "manual", createdAt: nowISO(), updatedAt: nowISO() }
      : await dbGet("farmacias", id);

    if (!f) { toast("No encontrada"); return; }

    dlgMainOpen(
      isNew ? "Alta farmacia" : "Editar farmacia",
      "Ficha básica",
      `
        <label>Nombre</label>
        <input id="fNombre" value="${escapeAttr(f.nombre || "")}" />

        <label>Código</label>
        <input id="fCodigo" value="${escapeAttr(f.codigo || "")}" placeholder="PO-041-F" />

        <label>Cliente (titular)</label>
        <input id="fCliente" value="${escapeAttr(f.cliente || "")}" />

        <label>Teléfono</label>
        <input id="fTel" value="${escapeAttr(f.telefono || "")}" />

        <label>Concello</label>
        <input id="fConc" value="${escapeAttr(f.concello || "")}" />

        <label>CP</label>
        <input id="fCp" value="${escapeAttr(f.cp || "")}" />

        <label>Dirección</label>
        <input id="fDir" value="${escapeAttr(f.direccion || "")}" />

        <div class="grid two">
          <div><label>Lat</label><input id="fLat" value="${escapeAttr(f.lat ?? "")}" /></div>
          <div><label>Lon</label><input id="fLon" value="${escapeAttr(f.lon ?? "")}" /></div>
        </div>
      `,
      `
        <div class="row">
          <div class="mini muted">${escapeHtml(f.source || "manual")} · ${escapeHtml(f.id)}</div>
          <div class="right flex">
            <button class="btn" id="fCancel">Cancelar</button>
            <button class="btn-primary" id="fSave">Guardar</button>
          </div>
        </div>
      `
    );

    $("#fCancel").onclick = () => dlgMainClose();
    $("#fSave").onclick = async () => {
      f.nombre = ($("#fNombre").value || "").trim();
      f.codigo = ($("#fCodigo").value || "").trim();
      f.cliente = ($("#fCliente").value || "").trim();
      f.telefono = ($("#fTel").value || "").trim();
      f.concello = ($("#fConc").value || "").trim();
      f.cp = ($("#fCp").value || "").trim();
      f.direccion = ($("#fDir").value || "").trim();
      const lat = ($("#fLat").value || "").trim();
      const lon = ($("#fLon").value || "").trim();
      f.lat = lat === "" ? null : Number(lat);
      f.lon = lon === "" ? null : Number(lon);
      f.updatedAt = nowISO();

      await dbPut("farmacias", f);
      toast("Guardado");
      dlgMainClose();
      await refreshState();
      render();
    };
  }

  async function openOpticaEdit(id) {
    const isNew = !id;
    const o = isNew
      ? { id: uid(), codigo: "", nombre: "", direccion: "", ciudad: "", telefono: "", cliente: "", lat: null, lon: null, source: "manual", createdAt: nowISO(), updatedAt: nowISO() }
      : await dbGet("opticas", id);

    if (!o) { toast("No encontrada"); return; }

    dlgMainOpen(
      isNew ? "Alta óptica" : "Editar óptica",
      "Ficha básica",
      `
        <label>Nombre</label>
        <input id="oNombre" value="${escapeAttr(o.nombre || "")}" />

        <label>Código</label>
        <input id="oCodigo" value="${escapeAttr(o.codigo || "")}" />

        <label>Cliente</label>
        <input id="oCliente" value="${escapeAttr(o.cliente || "")}" />

        <label>Teléfono</label>
        <input id="oTel" value="${escapeAttr(o.telefono || "")}" />

        <label>Ciudad</label>
        <input id="oCiudad" value="${escapeAttr(o.ciudad || "")}" />

        <label>Dirección</label>
        <input id="oDir" value="${escapeAttr(o.direccion || "")}" />

        <div class="grid two">
          <div><label>Lat</label><input id="oLat" value="${escapeAttr(o.lat ?? "")}" /></div>
          <div><label>Lon</label><input id="oLon" value="${escapeAttr(o.lon ?? "")}" /></div>
        </div>
      `,
      `
        <div class="row">
          <div class="mini muted">${escapeHtml(o.source || "manual")} · ${escapeHtml(o.id)}</div>
          <div class="right flex">
            <button class="btn" id="oCancel">Cancelar</button>
            <button class="btn-primary" id="oSave">Guardar</button>
          </div>
        </div>
      `
    );

    $("#oCancel").onclick = () => dlgMainClose();
    $("#oSave").onclick = async () => {
      o.nombre = ($("#oNombre").value || "").trim();
      o.codigo = ($("#oCodigo").value || "").trim();
      o.cliente = ($("#oCliente").value || "").trim();
      o.telefono = ($("#oTel").value || "").trim();
      o.ciudad = ($("#oCiudad").value || "").trim();
      o.direccion = ($("#oDir").value || "").trim();
      const lat = ($("#oLat").value || "").trim();
      const lon = ($("#oLon").value || "").trim();
      o.lat = lat === "" ? null : Number(lat);
      o.lon = lon === "" ? null : Number(lon);
      o.updatedAt = nowISO();

      await dbPut("opticas", o);
      toast("Guardado");
      dlgMainClose();
      await refreshState();
      render();
    };
  }

  async function openEntityDetails(entityType, entityId) {
    const ent = entityType === "optica" ? await dbGet("opticas", entityId) : await dbGet("farmacias", entityId);
    if (!ent) { toast("No encontrada"); return; }

    const pedidos = (await dbAll("pedidos"))
      .filter((p) => p.entityType === entityType && p.entityId === entityId)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    const ok = getPedidosOk(pedidos);
    const st = statsForEntity(entityId, entityType, ok);
    const nextTxt = st.hasEstimate ? `Próximo estimado: ${fmtDate(st.nextISO)} (media ${Math.round(st.avgDays)} días)` : "Próximo estimado: — (mín. 3 pedidos confirmados)";

    const last = pedidos.slice(0, 10);
    const url = mapsLinkForEntity(ent);

    dlgMainOpen(
      ent.nombre || ent.codigo || (entityType === "optica" ? "Óptica" : "Farmacia"),
      `${entityType === "optica" ? (ent.ciudad || "—") : (ent.concello || "—")} · Cliente: ${ent.cliente || "—"} · Tel: ${ent.telefono || "—"}`,
      `
        <div class="mini muted">
          <b>Código:</b> ${escapeHtml(ent.codigo || "—")}<br>
          <b>Dirección:</b> ${escapeHtml(ent.direccion || "—")}<br>
          ${entityType === "optica" ? `<b>Ciudad:</b> ${escapeHtml(ent.ciudad || "—")}<br>` : `<b>Concello:</b> ${escapeHtml(ent.concello || "—")}<br><b>CP:</b> ${escapeHtml(ent.cp || "—")}<br>`}
          <b>Cliente:</b> ${escapeHtml(ent.cliente || "—")}<br>
          <b>Teléfono:</b> ${escapeHtml(ent.telefono || "—")}<br>
          <div class="hr"></div>
          <b>${escapeHtml(nextTxt)}</b>
        </div>

        <div class="hr"></div>

        <h2>Últimos pedidos</h2>
        ${
          last.length
            ? `
              <div style="overflow:auto">
                <table>
                  <thead>
                    <tr>
                      <th style="width:110px">Fecha</th>
                      <th style="width:120px">Estado</th>
                      <th style="width:140px">Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${last
                      .map((p) => {
                        return `
                          <tr>
                            <td>${escapeHtml(fmtDate(p.fecha))}</td>
                            <td><span class="pill ${p.estado === "confirmado" ? "ok" : "warn"}">${escapeHtml(p.estado)}</span></td>
                            <td><b>${fmtEur(p.total || 0)}</b></td>
                            <td class="right"><button class="btn btn-xs" data-act="editPedido" data-id="${escapeAttr(p.id)}">Editar</button></td>
                          </tr>
                        `;
                      })
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
            : `<div class="muted">—</div>`
        }

        <div class="hr"></div>

        <h2>Acciones</h2>
        <div class="flex">
          <button class="btn" data-act="maps" ${url ? "" : "disabled"}>Abrir en Maps</button>
          <button class="btn-primary" data-act="visit">Visita</button>
          <button class="btn" data-act="editEnt">Editar ficha</button>
        </div>
      `,
      `
        <div class="row">
          <div class="mini muted">${escapeHtml(ent.source || "—")}</div>
          <div class="right"><button class="btn" id="dClose">Cerrar</button></div>
        </div>
      `
    );

    $("#dClose").onclick = () => dlgMainClose();

    $("#dlgMainBody").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;

      if (act === "maps") {
        if (url) window.open(url, "_blank", "noopener");
        return;
      }
      if (act === "visit") {
        dlgMainClose();
        openVisitaModal(entityType, entityId);
        return;
      }
      if (act === "editEnt") {
        dlgMainClose();
        entityType === "optica" ? openOpticaEdit(entityId) : openFarmaciaEdit(entityId);
        return;
      }
      if (act === "editPedido") {
        const pid = b.dataset.id;
        dlgMainClose();
        openPedidoEdit(pid);
      }
    };
  }

  async function openProductoEdit(id) {
    const isNew = !id;
    const p = isNew ? { id: uid(), nombre: "", descripcion: "", creadoEn: nowISO(), actualizadoEn: nowISO() } : await dbGet("productos", id);
    if (!p) { toast("No encontrado"); return; }

    dlgMainOpen(
      isNew ? "Nuevo producto" : "Editar producto",
      "Campos básicos",
      `
        <label>Nombre</label>
        <input id="pNombre" value="${escapeAttr(p.nombre || "")}" />
        <label>Descripción</label>
        <textarea id="pDesc">${escapeHtml(p.descripcion || "")}</textarea>
      `,
      `
        <div class="row">
          <div class="mini muted">${escapeHtml(p.id)}</div>
          <div class="right flex">
            <button class="btn" id="pCancel">Cancelar</button>
            <button class="btn-primary" id="pSave">Guardar</button>
          </div>
        </div>
      `
    );

    $("#pCancel").onclick = () => dlgMainClose();
    $("#pSave").onclick = async () => {
      p.nombre = ($("#pNombre").value || "").trim();
      p.descripcion = ($("#pDesc").value || "").trim();
      p.actualizadoEn = nowISO();
      await dbPut("productos", p);
      toast("Producto guardado");
      dlgMainClose();
      await refreshState();
      render();
    };
  }

  async function openPedidoEdit(id) {
    const isNew = !id;

    const misFarmIds = await getMisIds("misFarmacias", "farmaciaId");
    const misOptIds = await getMisIds("misOpticas", "opticaId");

    const farmacias = state.farmacias.filter(f => misFarmIds.has(f.id)).sort((a, b) => (a.nombre || a.codigo || "").localeCompare(b.nombre || b.codigo || "", "es"));
    const opticas = state.opticas.filter(o => misOptIds.has(o.id)).sort((a, b) => (a.nombre || a.codigo || "").localeCompare(b.nombre || b.codigo || "", "es"));
    const productos = state.productos.slice().sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));

    const p = isNew
      ? recomputePedido({
          id: uid(),
          entityType: "farmacia",
          entityId: farmacias[0]?.id || "",
          fecha: nowISO(),
          estado: "confirmado",
          elementos: 0,
          notas: "",
          lineas: [],
          total: 0,
          creadoEn: nowISO(),
          actualizadoEn: nowISO(),
        })
      : await dbGet("pedidos", id);

    if (!p) { toast("Pedido no encontrado"); return; }

    function buildLineRow(l, idx) {
      const prodName = l.nombre || "—";
      return `
        <div class="list-item">
          <div>
            <b>${escapeHtml(prodName)}</b><br>
            <span class="mini muted">Cant: ${escapeHtml(l.cantidad)} · PU: ${fmtEur(l.precioUnit)} · Total: <b>${fmtEur(l.total)}</b></span>
          </div>
          <div class="right flex">
            <button class="btn btn-xs" data-act="editLine" data-idx="${idx}">Editar</button>
            <button class="btn-danger btn-xs" data-act="delLine" data-idx="${idx}">Quitar</button>
          </div>
        </div>
      `;
    }

    function entOptions(type, selectedId) {
      const list = type === "optica" ? opticas : farmacias;
      if (!list.length) return `<option value="">(No hay “Mis” ${type === "optica" ? "ópticas" : "farmacias"})</option>`;
      return list
        .map((e) => {
          const name = e.nombre || e.codigo || (type === "optica" ? "Óptica" : "Farmacia");
          return `<option value="${escapeAttr(e.id)}"${e.id === selectedId ? " selected" : ""}>${escapeHtml(name)}</option>`;
        })
        .join("");
    }

    dlgMainOpen(
      isNew ? "Nuevo pedido" : "Editar pedido",
      "Pedido por farmacia/óptica (solo “Mis …”).",
      `
        <label>Tipo</label>
        <select id="pTipo">
          <option value="farmacia"${p.entityType === "farmacia" ? " selected" : ""}>Farmacia</option>
          <option value="optica"${p.entityType === "optica" ? " selected" : ""}>Óptica</option>
        </select>

        <label>Entidad</label>
        <select id="pEntSel"></select>

        <div class="grid two">
          <div>
            <label>Fecha</label>
            <input id="pFecha" type="date" value="${escapeAttr(new Date(p.fecha).toISOString().slice(0, 10))}" />
          </div>
          <div>
            <label>Estado</label>
            <select id="pEstado">
              ${["confirmado", "borrador"].map((s) => `<option${s === p.estado ? " selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="grid two">
          <div>
            <label>Elementos</label>
            <input id="pElem" type="number" min="0" step="1" value="${escapeAttr(p.elementos || 0)}" />
          </div>
          <div>
            <label>Total (calculado)</label>
            <input id="pTotal" disabled value="${escapeAttr(fmtEur(p.total || 0))}" />
          </div>
        </div>

        <label>Notas</label>
        <textarea id="pNotas">${escapeHtml(p.notas || "")}</textarea>

        <div class="hr"></div>

        <div class="row">
          <div>
            <h2>Productos</h2>
            <div class="mini muted">Añade varios productos y guarda el pedido.</div>
          </div>
          <div class="right">
            <button class="btn btn-xs" id="addLine">+ Añadir producto</button>
          </div>
        </div>

        <div id="linesBox" class="list"></div>
      `,
      `
        <div class="row">
          <div class="mini muted">${escapeHtml(p.id)}</div>
          <div class="right flex">
            <button class="btn" id="pCancel">Cancelar</button>
            <button class="btn-primary" id="pSave">Guardar</button>
          </div>
        </div>
      `
    );

    const entSel = $("#pEntSel");
    const tipoSel = $("#pTipo");

    function rebuildEntSel() {
      const t = (tipoSel.value || "farmacia").trim();
      p.entityType = t;
      entSel.innerHTML = entOptions(t, p.entityId);
      if (!p.entityId || !Array.from(entSel.options).some(o => o.value === p.entityId)) {
        p.entityId = entSel.value || "";
      } else {
        entSel.value = p.entityId;
      }
    }

    rebuildEntSel();
    tipoSel.onchange = () => { rebuildEntSel(); };

    const linesBox = $("#linesBox");
    function renderLines() {
      p.lineas = Array.isArray(p.lineas) ? p.lineas : [];
      recomputePedido(p);
      linesBox.innerHTML = p.lineas.length ? p.lineas.map(buildLineRow).join("") : `<div class="muted">—</div>`;
      $("#pTotal").value = fmtEur(p.total || 0);
      $("#pElem").value = String(p.elementos || 0);
    }
    renderLines();

    $("#pCancel").onclick = () => dlgMainClose();

    $("#pSave").onclick = async () => {
      p.entityType = ($("#pTipo").value || "farmacia").trim();
      p.entityId = ($("#pEntSel").value || "").trim();
      if (!p.entityId) { toast("Selecciona entidad"); return; }

      const ymd = ($("#pFecha").value || "").trim();
      const d = parseISODateYMD(ymd);
      if (!d) { toast("Fecha inválida"); return; }
      p.fecha = d.toISOString();
      p.estado = ($("#pEstado").value || "confirmado").trim();
      p.elementos = Math.max(0, Number($("#pElem").value || 0));
      p.notas = ($("#pNotas").value || "").trim();
      p.actualizadoEn = nowISO();
      recomputePedido(p);

      await dbPut("pedidos", p);
      toast("Pedido guardado");
      dlgMainClose();
      await refreshState();
      render();
    };

    $("#addLine").onclick = () => openLineEdit(p, null, productos, renderLines);

    $("#dlgMainBody").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;

      const act = b.dataset.act;
      const idx = Number(b.dataset.idx);

      if (act === "delLine") {
        p.lineas.splice(idx, 1);
        renderLines();
      }
      if (act === "editLine") {
        openLineEdit(p, idx, productos, renderLines);
      }
    };
  }

  function openLineEdit(pedido, idx, productos, onDone) {
    const isNew = idx == null;
    const l = isNew
      ? { id: uid(), productoId: productos[0]?.id || "", nombre: productos[0]?.nombre || "", cantidad: 1, precioUnit: 0, descuentoPct: 0, total: 0 }
      : { ...pedido.lineas[idx] };

    dlgSubOpen(
      isNew ? "Nuevo producto" : "Editar producto",
      "Detalle de línea",
      `
        <label>Producto</label>
        <select id="lProd">
          ${productos.map((pr) => `<option value="${escapeAttr(pr.id)}"${pr.id === l.productoId ? " selected" : ""}>${escapeHtml(pr.nombre)}</option>`).join("")}
        </select>

        <div class="grid two">
          <div>
            <label>Cantidad</label>
            <input id="lQty" type="number" min="0" step="1" value="${escapeAttr(l.cantidad)}" />
          </div>
          <div>
            <label>Precio unitario</label>
            <input id="lPU" type="number" min="0" step="0.01" value="${escapeAttr(l.precioUnit)}" />
          </div>
        </div>

        <label>Descuento (%)</label>
        <input id="lDto" type="number" min="0" step="0.5" value="${escapeAttr(l.descuentoPct || 0)}" />
      `,
      `
        <div class="row">
          <div class="mini muted">Total se recalcula al guardar</div>
          <div class="right flex">
            <button class="btn" id="lCancel">Cancelar</button>
            <button class="btn-primary" id="lSave">Guardar</button>
          </div>
        </div>
      `
    );

    $("#lCancel").onclick = () => dlgSubClose();
    $("#lSave").onclick = () => {
      const pid = ($("#lProd").value || "").trim();
      const pr = productos.find((x) => x.id === pid);
      l.productoId = pid;
      l.nombre = pr?.nombre || "Producto";
      l.cantidad = Math.max(0, Number($("#lQty").value || 0));
      l.precioUnit = Math.max(0, Number($("#lPU").value || 0));
      l.descuentoPct = Math.max(0, Number($("#lDto").value || 0));

      if (!Array.isArray(pedido.lineas)) pedido.lineas = [];
      if (isNew) pedido.lineas.push(l);
      else pedido.lineas[idx] = l;

      recomputePedido(pedido);
      dlgSubClose();
      onDone?.();
    };
  }

  function openImportPastePedidos() {
    dlgMainOpen(
      "Importar pedidos pegando JSON",
      "Pega un array JSON [] (formato cliente/estado/elementos/fecha/total_eur).",
      `
        <label>Tipo destino</label>
        <select id="impTipo">
          <option value="farmacia">Farmacias</option>
          <option value="optica">Ópticas</option>
        </select>
        <label>JSON</label>
        <textarea id="impTxt" placeholder='[{"cliente":"...","estado":"confirmado","elementos":3,"fecha":"2026-02-03","total_eur":123.45}]'></textarea>
      `,
      `
        <div class="row">
          <div class="mini muted">Se creará un pedido con producto “General”.</div>
          <div class="right flex">
            <button class="btn" id="impCancel">Cancelar</button>
            <button class="btn-primary" id="impGo">Importar</button>
          </div>
        </div>
      `
    );

    $("#impCancel").onclick = () => dlgMainClose();
    $("#impGo").onclick = async () => {
      const tipo = ($("#impTipo").value || "farmacia").trim();
      const txt = ($("#impTxt").value || "").trim();
      if (!txt) { toast("Pega el JSON"); return; }
      let arr;
      try { arr = JSON.parse(txt); } catch { toast("JSON inválido"); return; }
      await importPedidosJsonArray(arr, tipo);
      dlgMainClose();
      await refreshState();
      render();
    };
  }

  async function openVisitaModal(entityType, entityId) {
    // if null, allow selecting
    const farmIds = await getMisIds("misFarmacias", "farmaciaId");
    const optIds = await getMisIds("misOpticas", "opticaId");
    const farms = state.farmacias.filter(f => farmIds.has(f.id)).sort((a,b)=> (a.nombre||a.codigo||"").localeCompare(b.nombre||b.codigo||"", "es"));
    const opts = state.opticas.filter(o => optIds.has(o.id)).sort((a,b)=> (a.nombre||a.codigo||"").localeCompare(b.nombre||b.codigo||"", "es"));

    const day = todayYMD();
    const type0 = entityType || "farmacia";
    const ent0 = entityId || (type0 === "optica" ? (opts[0]?.id || "") : (farms[0]?.id || ""));

    function entOptions(type, selectedId) {
      const list = type === "optica" ? opts : farms;
      if (!list.length) return `<option value="">(No hay “Mis” ${type === "optica" ? "ópticas" : "farmacias"})</option>`;
      return list.map(e => {
        const name = e.nombre || e.codigo || (type === "optica" ? "Óptica" : "Farmacia");
        return `<option value="${escapeAttr(e.id)}"${e.id===selectedId?" selected":""}>${escapeHtml(name)}</option>`;
      }).join("");
    }

    dlgMainOpen(
      "Registrar visita",
      "Fecha + notas",
      `
        <label>Tipo</label>
        <select id="vTipo">
          <option value="farmacia"${type0==="farmacia"?" selected":""}>Farmacia</option>
          <option value="optica"${type0==="optica"?" selected":""}>Óptica</option>
        </select>

        <label>Entidad</label>
        <select id="vEnt"></select>

        <label>Día</label>
        <input id="vDay" type="date" value="${escapeAttr(day)}" />

        <label>Notas</label>
        <textarea id="vNotas" placeholder="Qué pasó, próximos pasos..."></textarea>
      `,
      `
        <div class="row">
          <div class="mini muted">Se guarda en Visitas.</div>
          <div class="right flex">
            <button class="btn" id="vCancel">Cancelar</button>
            <button class="btn-primary" id="vSave">Guardar</button>
          </div>
        </div>
      `
    );

    const tipoSel = $("#vTipo");
    const entSel = $("#vEnt");

    function rebuildEnt() {
      const t = (tipoSel.value || "farmacia").trim();
      entSel.innerHTML = entOptions(t, ent0);
      if (!entSel.value) entSel.value = ent0;
    }
    rebuildEnt();
    tipoSel.onchange = rebuildEnt;

    $("#vCancel").onclick = () => dlgMainClose();
    $("#vSave").onclick = async () => {
      const t = (tipoSel.value || "farmacia").trim();
      const eid = (entSel.value || "").trim();
      if (!eid) { toast("Selecciona entidad"); return; }
      const ymd = ($("#vDay").value || "").trim();
      const d = parseISODateYMD(ymd);
      if (!d) { toast("Fecha inválida"); return; }

      const v = { id: uid(), entityType: t, entityId: eid, fecha: d.toISOString(), day: ymd, notas: ($("#vNotas").value || "").trim(), createdAt: nowISO() };
      await dbPut("visitas", v);
      toast("Visita guardada");
      dlgMainClose();
      await refreshState();
      render();
    };
  }

  /**********************
   * Seed
   **********************/
  async function seedIfEmpty() {
    const farms = await dbAll("farmacias");
    if (farms.length) return;

    const f = {
      id: uid(),
      codigo: "DEMO-001",
      nombre: "Farmacia Demo",
      direccion: "C/ Michelena 10, Pontevedra",
      cp: "36002",
      concello: "Pontevedra",
      telefono: "000000000",
      cliente: "Cliente Demo",
      lat: null,
      lon: null,
      source: "manual",
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    await dbPut("farmacias", f);
  }

  /**********************
   * Render dispatcher
   **********************/
  async function render() {
    const viewEl = $("#view");
    if (!viewEl) return;

    $("#btnHome").onclick = () => setView("dash");
    $("#btnSync").onclick = async () => { await fullResync(); };

    if (state.view === "dash") return renderDashboard(viewEl);
    if (state.view === "predicciones") return renderPredicciones(viewEl);

    if (state.view === "farmacias") return renderFarmaciasCatalog(viewEl);
    if (state.view === "misfarmacias") return renderMisFarmacias(viewEl);

    if (state.view === "opticas") return renderOpticasCatalog(viewEl);
    if (state.view === "misopticas") return renderMisOpticas(viewEl);

    if (state.view === "pedidos") return renderPedidos(viewEl);
    if (state.view === "productos") return renderProductos(viewEl);

    if (state.view === "rutas") return renderRutas(viewEl);
    if (state.view === "visitas") return renderVisitas(viewEl);

    if (state.view === "backup") return renderBackup(viewEl);
    if (state.view === "ajustes") return renderAjustes(viewEl);
    if (state.view === "admin") return renderAdmin(viewEl);

    viewEl.innerHTML = `<div class="card"><h2>Vista no encontrada</h2></div>`;
  }

  /**********************
   * Nav wiring
   **********************/
  function wireTabs() {
    const tabs = $("#tabs");
    if (!tabs) return;
    tabs.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const v = b.dataset.view;
      if (!v) return;
      setView(v);
    };
  }

  /**********************
   * PWA Install + SW register
   **********************/
  let deferredPrompt = null;
  function wirePwaInstall() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = $("#btnInstall");
      if (btn) btn.style.display = "inline-flex";
    });

    const btn = $("#btnInstall");
    if (btn) {
      btn.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        btn.style.display = "none";
      };
    }
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      // silent
    }
  }

  /**********************
   * Dialog close wiring
   **********************/
  function wireDialogClose() {
    $("#dlgMainClose").onclick = () => dlgMainClose();
    $("#dlgMain").addEventListener("cancel", (e) => { e.preventDefault(); dlgMainClose(); });

    $("#dlgSubClose").onclick = () => dlgSubClose();
    $("#dlgSub").addEventListener("cancel", (e) => { e.preventDefault(); dlgSubClose(); });
  }

  /**********************
   * Supabase boot
   **********************/
  async function bootSupabase() {
    const settings = await loadSettings();
    if (!supaConfigured(settings)) {
      SUPA.ready = false;
      SUPA.url = null;
      SUPA.anon = null;
      // hide sync button
      const btnSync = $("#btnSync");
      if (btnSync) btnSync.style.display = "none";
      return;
    }

    SUPA.url = String(settings.supabaseUrl).trim();
    SUPA.anon = String(settings.supabaseAnonKey).trim();
    SUPA.ready = true;

    // restore session
    const sess = await authGet("session");
    if (sess && sess.access_token) {
      SUPA.session = sess;
      SUPA.userId = sess.user?.id || null;
      try {
        await supaLoadProfile();
      } catch {
        // ignore
      }
    }
  }

  /**********************
   * Boot
   **********************/
  (async () => {
    try {
      db = await openDB();
      await seedIfEmpty();

      wireTabs();
      wireDialogClose();
      wirePwaInstall();
      registerSW();

      await refreshState();
      await bootSupabase();

      // show sync button if logged
      const btnSync = $("#btnSync");
      if (btnSync) btnSync.style.display = SUPA.ready && SUPA.userId ? "inline-flex" : "none";

      // first render
      setView("dash");

      // best-effort background sync on visibility
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible") {
          try { await outboxProcess(50); } catch {}
        }
      });
    } catch (e) {
      console.error(e);
      toast("Error arrancando app: " + (e?.message || e), 5000);
    }
  })();
})();
