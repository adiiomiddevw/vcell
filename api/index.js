import { Readable as r, pipeline as p } from "node:stream";
export const config = { api: { bodyParser: false }, supportsResponseStreaming: true, maxDuration: 60 };
const b = (process.env.ASSETS_CDN || "").replace(/\/$/, "");
const s = new Set(["host","connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","forwarded","x-forwarded-host","x-forwarded-proto","x-forwarded-port"]);
export default async function h(req, res) {
  if (!b) { res.statusCode = 500; return res.end("error"); }
  try {
    const u = b + req.url, o = {};
    let i = null;
    for (const k of Object.keys(req.headers)) {
      const l = k.toLowerCase(), v = req.headers[k];
      if (s.has(l) || l.startsWith("x-vercel-")) continue;
      if (l === "x-real-ip") { i = v; continue; }
      if (l === "x-forwarded-for") { if (!i) i = v; continue; }
      o[l] = Array.isArray(v) ? v.join(", ") : v;
    }
    if (i) o["x-forwarded-for"] = i;
    o["x-req-id"] = Math.random().toString(36);
    const m = req.method, hb = m !== "GET" && m !== "HEAD";
    const opt = { method: m, headers: o, redirect: "manual" };
    if (hb) { opt.body = r.toWeb(req); opt.duplex = "half"; }
    const up = await fetch(u, opt);
    res.statusCode = up.status;
    for (const [k, v] of up.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try { res.setHeader(k, v); } catch {}
    }
    up.body ? await p(r.fromWeb(up.body), res) : res.end();
  } catch (e) { console.error("x"); if (!res.headersSent) { res.statusCode = 502; res.end(); } }
}
