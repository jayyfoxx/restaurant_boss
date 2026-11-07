// Restaurant Boss shared sync. Every device that uses the same show code
// reads and writes the same data here. Data lives in Netlify Blobs, so there is
// no database to set up and no environment variables to add.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const FIELDS = ["name", "star", "locked", "revealed", "health", "j1", "j2", "j3", "jn1", "jn2", "jn3", "view"];

function clean(f, v) {
  switch (f) {
    case "name": return String(v ?? "").slice(0, 60);
    case "star": return String(v ?? "").slice(0, 40);
    case "health": return String(v ?? "").slice(0, 8);
    case "jn1": case "jn2": case "jn3": return String(v ?? "").slice(0, 30);
    case "locked":
    case "revealed": return !!v;
    case "j1": case "j2": case "j3": {
      if (v === null || v === undefined) return null;
      const n = Math.round(Number(v));
      return n >= 1 && n <= 10 ? n : null;
    }
    case "view": {
      const z = Math.min(4, Math.max(1, Number(v?.z) || 1));
      const cx = Math.min(1, Math.max(0, Number(v?.cx ?? 0.5)));
      const cy = Math.min(1, Math.max(0, Number(v?.cy ?? 0.5)));
      return { z, cx, cy };
    }
  }
  return undefined;
}

export default async (req) => {
  if (req.method !== "POST") return J({ error: "POST only" }, 405);
  let b;
  try { b = await req.json(); } catch { return J({ error: "bad request" }, 400); }

  const store = getStore({ name: "restaurant-boss", consistency: "strong" });
  const action = b.action;

  // Customers on their own phones use the short survey code, never the host show code.
  let ws;
  const isGuest = action === "guestInfo" || action === "guestSurvey";
  if (isGuest) {
    const g = String(b.gcode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (g.length < 4) return J({ error: "Enter the survey code" }, 400);
    const rec = await store.get(`guest/${g}`, { type: "json" });
    if (!rec) return J({ error: "That survey code was not found" }, 404);
    if (rec.ended) return J({ ok: true, closed: true, ended: true, name: "", star: "" });   // an old show's code
    ws = rec.ws;
  } else {
    const code = String(b.code || "").trim().toLowerCase();
    if (code.length < 6) return J({ error: "Show code must be at least 6 characters" }, 400);
    ws = createHash("sha256").update("restaurant-boss:" + code).digest("hex").slice(0, 40);
  }

  const kMeta = (id) => `${ws}/meta/${id}`;
  const kSurveyPrefix = (id) => `${ws}/survey/${id}/`;
  const kPhoto = (id) => `${ws}/photo/${id}`;
  const kPhotoSmall = (id) => `${ws}/photosmall/${id}`;   // small copy for customer phones
  const kPointer = `${ws}/pointer`;

  const getMeta = (id) => store.get(kMeta(id), { type: "json" });
  const setMeta = (m) => store.setJSON(kMeta(m.id), m);
  const newMeta = (extra = {}) => ({
    id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    created: Date.now(), archived: false, summary: null, fields: {}, photoRev: 0, ...extra,
  });

  // survey keys carry the answers, so one list call returns every survey
  // key: <id>.<q1><q2><q3><q5>.<q4>   (id looks like 1731000000000.ab12)
  const surveyKey = (id, s) => `${kSurveyPrefix(id)}${s.id}.${s.q1}${s.q2}${s.q3}${s.q5}.${s.q4}`;
  const parseSurveyKey = (key) => {
    const rest = key.split("/").pop();
    const p = rest.split(".");              // [t, rand, bits, q4]
    if (p.length !== 4 || p[2].length !== 4) return null;
    return { id: p[0] + "." + p[1], q1: +p[2][0], q2: +p[2][1], q3: +p[2][2], q5: +p[2][3], q4: +p[3], t: +p[0] };
  };
  async function listSurveys(id) {
    const { blobs } = await store.list({ prefix: kSurveyPrefix(id) });
    return blobs.map((x) => parseSurveyKey(x.key)).filter(Boolean).sort((a, c) => a.t - c.t);
  }
  const isEmpty = async (m) => {
    if (Object.keys(m.fields).length || m.photoRev) return false;
    return (await listSurveys(m.id)).length === 0;
  };

  async function current() {
    let ptr = await store.get(kPointer, { type: "json" });
    let m = ptr ? await getMeta(ptr.currentId) : null;
    if (!m) {
      m = newMeta();
      await setMeta(m);
      await store.setJSON(kPointer, { currentId: m.id });
    }
    return m;
  }

  // a fresh short code for customers; the old one keeps working only to say "this show has ended"
  async function makeGuestCode() {
    const kRec = `${ws}/guest`;
    const old = await store.get(kRec, { type: "text" });
    if (old) await store.setJSON(`guest/${old}`, { ws, ended: true });
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let g = "";
    for (let tries = 0; tries < 20; tries++) {
      g = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
      if (!(await store.get(`guest/${g}`, { type: "text" }))) break;
    }
    await store.setJSON(`guest/${g}`, { ws });
    await store.set(kRec, g);
    return g;
  }

  const view = async (m) => ({
    id: m.id, fields: m.fields, photoRev: m.photoRev, created: m.created, surveys: await listSurveys(m.id),
  });

  try {
    // ---------- phone surveys (customers) ----------
    if (action === "guestInfo") {
      const m = await current();
      let photo = null;
      if (m.photoRev) photo = (await store.get(kPhotoSmall(m.id), { type: "text" })) || (await store.get(kPhoto(m.id), { type: "text" }));
      return J({ ok: true, showId: m.id, name: m.fields.name || "", star: m.fields.star || "", closed: !!m.fields.locked, photo, view: m.fields.view || null });
    }

    if (action === "guestSurvey") {
      const m = await current();
      if (m.fields.locked) return J({ closed: true });
      const token = String(b.token || "");
      if (!/^[a-z0-9]{12,40}$/.test(token)) return J({ error: "bad request" }, 400);
      const s = b.survey || {};
      const ok = [s.q1, s.q2, s.q3, s.q5].every((v) => v === 0 || v === 1) && Number.isInteger(s.q4) && s.q4 >= 1 && s.q4 <= 10;
      if (!ok) return J({ error: "Please answer every question" }, 400);
      const doneKey = `${ws}/gdone/${m.id}/${token}`;
      if (await store.get(doneKey, { type: "text" })) return J({ already: true });
      const id = `${Date.now()}.g${(Math.random().toString(36) + "000").slice(2, 5)}`;
      await store.set(surveyKey(m.id, { id, q1: s.q1, q2: s.q2, q3: s.q3, q4: s.q4, q5: s.q5 }), "1");
      await store.set(doneKey, "1");
      return J({ ok: true });
    }

    // host asks for (or makes) the short survey code that customers use
    if (action === "guestCode" || action === "guestReset") {
      const old = await store.get(`${ws}/guest`, { type: "text" });
      if (old && action === "guestCode") {
        const rec = await store.get(`guest/${old}`, { type: "json" });
        if (rec && !rec.ended) return J({ ok: true, gcode: old });
      }
      return J({ ok: true, gcode: await makeGuestCode() });
    }

    if (action === "sync") {
      const m = await current();
      return J({ ok: true, current: await view(m) });
    }

    if (action === "patch") {
      const m = await current();
      if (b.showId !== m.id) return J({ stale: true, current: await view(m) });
      for (const f of FIELDS) {
        if (b.fields && Object.prototype.hasOwnProperty.call(b.fields, f)) m.fields[f] = clean(f, b.fields[f]);
      }
      await setMeta(m);
      return J({ ok: true });
    }

    if (action === "addSurvey") {
      const m = await current();
      if (b.showId !== m.id) return J({ stale: true, current: await view(m) });
      const s = b.survey || {};
      const ok = /^\d{10,14}\.[a-z0-9]{2,8}$/.test(String(s.id)) &&
        [s.q1, s.q2, s.q3, s.q5].every((v) => v === 0 || v === 1) && Number.isInteger(s.q4) && s.q4 >= 1 && s.q4 <= 10;
      if (!ok) return J({ error: "bad survey" }, 400);
      await store.set(surveyKey(m.id, s), "1");
      return J({ ok: true });
    }

    if (action === "delSurvey") {
      const m = await current();
      if (b.showId !== m.id) return J({ stale: true, current: await view(m) });
      if (!/^\d{10,14}\.[a-z0-9]{2,8}$/.test(String(b.id))) return J({ error: "bad id" }, 400);
      const { blobs } = await store.list({ prefix: kSurveyPrefix(m.id) + b.id + "." });
      await Promise.all(blobs.map((x) => store.delete(x.key)));
      return J({ ok: true });
    }

    if (action === "photo") {
      const m = await current();
      if (b.showId !== m.id) return J({ stale: true, current: await view(m) });
      const url = String(b.url || "");
      if (!url.startsWith("data:image/") || url.length > 4_500_000) return J({ error: "bad photo" }, 400);
      await store.set(kPhoto(m.id), url);
      const small = String(b.small || "");
      if (small.startsWith("data:image/") && small.length < 600_000) await store.set(kPhotoSmall(m.id), small);
      else await store.delete(kPhotoSmall(m.id));
      m.photoRev = Date.now();
      await setMeta(m);
      return J({ ok: true, photoRev: m.photoRev });
    }

    if (action === "getPhoto") {
      const url = await store.get(kPhoto(String(b.showId || "")), { type: "text" });
      return J({ ok: true, url: url || null });
    }

    if (action === "newShow") {
      const m = await current();
      if (await isEmpty(m)) return J({ ok: true, current: await view(m) });
      m.archived = true;
      m.archivedAt = Date.now();
      m.summary = b.summary && typeof b.summary === "object" ? {
        grade: String(b.summary.grade || "?").slice(0, 2),
        score: b.summary.score === null ? null : Number(b.summary.score),
        surveys: Number(b.summary.surveys) || 0,
        thumb: String(b.summary.thumb || "").slice(0, 30000),
      } : null;
      await setMeta(m);
      const n = newMeta();
      await setMeta(n);
      await store.setJSON(kPointer, { currentId: n.id });
      if (await store.get(`${ws}/guest`, { type: "text" })) await makeGuestCode();   // every show gets its own QR
      return J({ ok: true, current: await view(n) });
    }

    if (action === "shows") {
      const { blobs } = await store.list({ prefix: `${ws}/meta/` });
      const metas = (await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" })))).filter((m) => m && m.archived);
      metas.sort((a, c) => (c.archivedAt || c.created) - (a.archivedAt || a.created));
      return J({
        ok: true,
        shows: metas.slice(0, 60).map((m) => ({
          id: m.id, name: m.fields.name || "", star: m.fields.star || "", date: m.archivedAt || m.created, summary: m.summary,
        })),
      });
    }

    if (action === "showDetail") {
      const m = await getMeta(String(b.id || ""));
      if (!m) return J({ error: "not found" }, 404);
      return J({ ok: true, show: await view(m) });
    }

    if (action === "deleteShow") {
      const id = String(b.id || "");
      const m = await getMeta(id);
      if (!m || !m.archived) return J({ error: "not found" }, 404);
      const { blobs } = await store.list({ prefix: kSurveyPrefix(id) });
      await Promise.all(blobs.map((x) => store.delete(x.key)));
      await store.delete(kPhoto(id));
      await store.delete(kMeta(id));
      return J({ ok: true });
    }

    // copy a show that only lived on one device into the shared list
    if (action === "importShow") {
      const d = b.show || {};
      const m = newMeta({ archived: true, archivedAt: Number(d.date) || Date.now() });
      for (const f of FIELDS) if (d.fields && f in d.fields) m.fields[f] = clean(f, d.fields[f]);
      m.summary = d.summary ? {
        grade: String(d.summary.grade || "?").slice(0, 2),
        score: d.summary.score === null ? null : Number(d.summary.score),
        surveys: Number(d.summary.surveys) || 0,
        thumb: String(d.summary.thumb || "").slice(0, 30000),
      } : null;
      const list = Array.isArray(d.surveys) ? d.surveys.slice(0, 500) : [];
      let i = 0;
      for (const s of list) {
        const t = String(Math.round(Number(s.t) || Date.now()) + i++);
        const sv = { id: t + ".i" + i.toString(36), q1: +s.q1 ? 1 : 0, q2: +s.q2 ? 1 : 0, q3: +s.q3 ? 1 : 0, q5: +s.q5 ? 1 : 0, q4: Math.min(10, Math.max(1, Math.round(+s.q4) || 1)) };
        if (/^\d{10,14}\.[a-z0-9]{2,8}$/.test(sv.id)) await store.set(surveyKey(m.id, sv), "1");
      }
      if (typeof d.photo === "string" && d.photo.startsWith("data:image/") && d.photo.length < 4_500_000) {
        await store.set(kPhoto(m.id), d.photo);
        m.photoRev = Date.now();
      }
      await setMeta(m);
      return J({ ok: true, id: m.id });
    }

    return J({ error: "unknown action" }, 400);
  } catch (e) {
    return J({ error: "server error", detail: String(e && e.message || e) }, 500);
  }
};
