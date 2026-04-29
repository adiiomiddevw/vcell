import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: {
    bodyParser: false
  },
  supportsResponseStreaming: true,
  maxDuration: 60
};

const UPSTREAM_URL = (process.env.UPSTREAM_URL || "").replace(/\/$/, "");

export default async function handler(req, res) {
  if (!UPSTREAM_URL) {
    res.statusCode = 500;
    return res.end("Upstream URL not configured");
  }

  try {
    const target = UPSTREAM_URL + req.url;
    const headers = {};

    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === "host") continue;
      if (lower === "connection") continue;
      if (lower === "transfer-encoding") continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOptions = {
      method: method,
      headers: headers,
      redirect: "manual"
    };

    if (hasBody) {
      fetchOptions.body = Readable.toWeb(req);
      fetchOptions.duplex = "half";
    }

    const response = await fetch(target, fetchOptions);
    res.statusCode = response.status;

    for (const [key, value] of response.headers) {
      if (key.toLowerCase() !== "transfer-encoding") {
        res.setHeader(key, value);
      }
    }

    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error("Proxy error:", error);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway");
    }
  }
}
