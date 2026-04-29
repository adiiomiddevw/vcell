import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const TARGET_BASE = (process.env.STORAGE_URL || "").replace(/\/$/, "");

export default async function handler(req, res) {
  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end("Missing config");
  }

  try {
    const targetUrl = TARGET_BASE + req.url;
    const headers = {};

    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (["host", "connection", "transfer-encoding"].includes(lowerKey)) continue;
      headers[lowerKey] = Array.isArray(value) ? value.join(", ") : value;
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? Readable.toWeb(req) : undefined,
      duplex: "half"
    });

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
  } catch (err) {
    console.error(err);
    res.statusCode = 502;
    res.end("Proxy error");
  }
}
