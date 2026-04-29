import { Readable as R, pipeline as P } from "node:stream/promises";

const _cfg = { api: { bodyParser: !1 }, supportsResponseStreaming: !0, maxDuration: 60 };
export const config = _cfg;

const _B = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const _S = new Set(["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"]);

export default async function h(_r, _w) {
  if (!_B) return _w.statusCode = 500, _w.end("Misconfigured: TARGET_DOMAIN is not set");

  try {
    const _u = _B + _r.url;
    const _H = {};
    let _ip = null;

    for (let _k of Object.keys(_r.headers)) {
      let _l = _k.toLowerCase(), _v = _r.headers[_k];
      if (_S.has(_l)) continue;
      if (_l.startsWith("x-vercel-")) continue;
      if (_l === "x-real-ip") { _ip = _v; continue; }
      if (_l === "x-forwarded-for") { if (!_ip) _ip = _v; continue; }
      _H[_l] = Array.isArray(_v) ? _v.join(", ") : _v;
    }
    if (_ip) _H["x-forwarded-for"] = _ip;

    const _m = _r.method, _hb = _m !== "GET" && _m !== "HEAD";
    const _opt = { method: _m, headers: _H, redirect: "manual" };
    if (_hb) { _opt.body = R.toWeb(_r); _opt.duplex = "half"; }

    const _up = await fetch(_u, _opt);
    _w.statusCode = _up.status;

    for (let [k, v] of _up.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try { _w.setHeader(k, v); } catch {}
    }

    _up.body ? await P(R.fromWeb(_up.body), _w) : _w.end();
  } catch (e) {
    console.error("proxy err:", e);
    if (!_w.headersSent) _w.statusCode = 502, _w.end("Bad Gateway: Tunnel Failed");
  }
}
