import { Readable as _stream_readable } from "node:stream";
import { pipeline as _stream_pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const __target_base = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const __strip_headers_set = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"
]);

export default async function __relay_handler(__req, __res) {
  if (!__target_base) {
    __res.statusCode = 500;
    return __res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    const __url = __target_base + __req.url;
    const __headers_out = {};
    let __client_ip = null;

    const __header_keys = Object.keys(__req.headers);
    for (let __idx = 0; __idx < __header_keys.length; __idx++) {
      const __raw_key = __header_keys[__idx];
      const __key_lower = __raw_key.toLowerCase();
      const __val = __req.headers[__raw_key];

      if (__strip_headers_set.has(__key_lower)) continue;
      if (__key_lower.startsWith("x-vercel-")) continue;
      if (__key_lower === "x-real-ip") {
        __client_ip = __val;
        continue;
      }
      if (__key_lower === "x-forwarded-for") {
        if (!__client_ip) __client_ip = __val;
        continue;
      }
      __headers_out[__key_lower] = Array.isArray(__val) ? __val.join(", ") : __val;
    }

    if (__client_ip) __headers_out["x-forwarded-for"] = __client_ip;

    const __method = __req.method;
    const __has_body = __method !== "GET" && __method !== "HEAD";

    const __fetch_options = {
      method: __method,
      headers: __headers_out,
      redirect: "manual"
    };

    if (__has_body) {
      __fetch_options.body = _stream_readable.toWeb(__req);
      __fetch_options.duplex = "half";
    }

    const __upstream_res = await fetch(__url, __fetch_options);

    __res.statusCode = __upstream_res.status;

    const __resp_headers = __upstream_res.headers;
    for (const [__hk, __hv] of __resp_headers) {
      if (__hk.toLowerCase() === "transfer-encoding") continue;
      try { __res.setHeader(__hk, __hv); } catch {}
    }

    if (__upstream_res.body) {
      await _stream_pipeline(_stream_readable.fromWeb(__upstream_res.body), __res);
    } else {
      __res.end();
    }
  } catch (__err) {
    console.error("[relay]", __err);
    if (!__res.headersSent) {
      __res.statusCode = 502;
      __res.end("Bad Gateway: Tunnel Failed");
    }
  }
}
