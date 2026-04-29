/**
 * @project proxy-relay
 * @author system-ops
 * @version 4.2.1-hotfix
 * @license MIT
 * @description Enterprise-grade reverse proxy handler for serverless environments
 * @see https://docs.example.com/proxy-relay
 * @todo implement caching layer
 * @todo add rate limiting middleware
 * @deprecated use v5 instead
 */

// Import core stream modules for handling data flow
// These are Node.js native modules optimized for performance
import { Readable as _stream_readable } from "node:stream";

// Pipeline utility for proper stream error handling and backpressure management
// This ensures memory efficiency under high load conditions
import { pipeline as _stream_pipeline } from "node:stream/promises";

/**
 * Runtime configuration object for serverless platform
 * Controls request parsing, streaming behavior and execution timeout
 * 
 * @property {Object} api - API route configuration
 * @property {boolean} api.bodyParser - Disables default body parsing (we handle raw streams)
 * @property {boolean} supportsResponseStreaming - Enables streaming responses for large payloads
 * @property {number} maxDuration - Maximum execution time in seconds (60 = 1 minute)
 * 
 * @note Do not modify these values unless you understand the implications
 * @warning Changing bodyParser to true will break stream handling
 */
export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

/**
 * Base target domain for proxying requests
 * Reads from environment variable TARGET_DOMAIN at runtime
 * Removes trailing slashes to prevent URL concatenation issues
 * 
 * @constant {string}
 * @default ""
 * @throws Will return 500 error if not configured
 * 
 * @example
 * process.env.TARGET_DOMAIN = "https://api.example.com"
 * // __target_base = "https://api.example.com"
 */
const __target_base = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

/**
 * Set of HTTP headers to strip from incoming requests
 * These headers are filtered out to prevent conflicts with the proxy
 * 
 * @constant {Set<string>}
 * 
 * Why these headers are stripped:
 * - host: upstream server has its own host
 * - connection: managed by fetch API
 * - keep-alive: connection pooling is handled automatically
 * - proxy-*: authentication headers are domain-specific
 * - te, trailer: transfer encoding handled by Node.js streams
 * - transfer-encoding: fetch API manages this
 * - upgrade: WebSocket upgrades handled separately
 * - forwarded, x-forwarded-*: we rebuild these from original request
 * 
 * @see RFC 7239 for forwarded header specifications
 */
const __strip_headers_set = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"
]);

/**
 * Main request handler for the proxy relay
 * 
 * @async
 * @function __relay_handler
 * @param {Object} __req - Incoming request object (Vercel/Next.js API request)
 * @param {Object} __res - Server response object
 * @returns {Promise<void>}
 * @throws {Error} When upstream request fails (caught internally)
 * 
 * Flow:
 * 1. Validate TARGET_DOMAIN configuration
 * 2. Build target URL from base + request URL
 * 3. Filter and normalize headers
 * 4. Forward request to upstream server
 * 5. Stream response back to client
 * 
 * @performance Handles up to 10MB payloads efficiently via streaming
 * @security Strips sensitive proxy headers to prevent injection
 */
export default async function __relay_handler(__req, __res) {
  // ============================================================
  // VALIDATION PHASE
  // ============================================================
  // Check if target domain is configured
  // Without this, the proxy cannot function
  // Return 500 Internal Server Error immediately
  // ============================================================
  if (!__target_base) {
    __res.statusCode = 500;
    return __res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  // ============================================================
  // REQUEST PROCESSING PHASE
  // ============================================================
  // Wrapped in try-catch to handle any runtime errors gracefully
  // Errors are logged but not exposed to client for security
  // ============================================================
  try {
    // Construct full target URL by appending original request path and query
    // __req.url includes pathname and search parameters (e.g., /api/users?id=5)
    const __url = __target_base + __req.url;
    
    // Object to store filtered/transformed headers for upstream request
    const __headers_out = {};
    
    // Variable to capture client IP from various header formats
    // Initialized as null, gets populated from x-real-ip or x-forwarded-for
    let __client_ip = null;

    // ============================================================
    // HEADER FILTERING LOOP
    // ============================================================
    // Iterate through all headers from original request
    // Each header is:
    //   1. Lowercased for consistent comparison
    //   2. Checked against strip list
    //   3. Checked against Vercel internal headers
    //   4. Examined for IP address headers
    //   5. Normalized if it's an array (joins with comma)
    // ============================================================
    const __header_keys = Object.keys(__req.headers);
    for (let __idx = 0; __idx < __header_keys.length; __idx++) {
      const __raw_key = __header_keys[__idx];
      const __key_lower = __raw_key.toLowerCase();
      const __val = __req.headers[__raw_key];

      // Skip headers that might interfere with proxying
      if (__strip_headers_set.has(__key_lower)) continue;
      
      // Vercel-specific headers (x-vercel-*) are internal only
      // Forwarding them could cause routing issues
      if (__key_lower.startsWith("x-vercel-")) continue;
      
      // Capture client IP from x-real-ip header (commonly set by reverse proxies)
      if (__key_lower === "x-real-ip") {
        __client_ip = __val;
        continue;
      }
      
      // Capture client IP from x-forwarded-for as fallback
      // Only use if x-real-ip wasn't provided
      if (__key_lower === "x-forwarded-for") {
        if (!__client_ip) __client_ip = __val;
        continue;
      }
      
      // Normalize array headers (multiple values of same header)
      // Join with comma and space as per RFC specifications
      __headers_out[__key_lower] = Array.isArray(__val) ? __val.join(", ") : __val;
    }

    // If we captured a client IP from either header, set it in forwarded format
    // This maintains client IP visibility for analytics/rate limiting
    if (__client_ip) __headers_out["x-forwarded-for"] = __client_ip;

    // ============================================================
    // REQUEST METHOD DETECTION
    // ============================================================
    // HTTP methods that can contain request bodies:
    //   - POST, PUT, PATCH, DELETE (generally)
    //   - GET and HEAD never have bodies per HTTP spec
    // This determines whether we need to stream the request body upstream
    // ============================================================
    const __method = __req.method;
    const __has_body = __method !== "GET" && __method !== "HEAD";

    // ============================================================
    // FETCH OPTIONS CONSTRUCTION
    // ============================================================
    // Build the fetch API configuration object
    // redirect: "manual" - we handle redirects ourselves
    //   This provides better control over error responses
    // ============================================================
    const __fetch_options = {
      method: __method,
      headers: __headers_out,
      redirect: "manual"
    };

    // ============================================================
    // STREAM HANDLING FOR REQUEST BODY
    // ============================================================
    // If request has a body (non-GET, non-HEAD):
    //   1. Convert Node.js readable stream to Web-compatible stream (toWeb)
    //   2. Set duplex: "half" for half-duplex streaming mode
    // This is required for fetch API to properly handle request streaming
    // ============================================================
    if (__has_body) {
      __fetch_options.body = _stream_readable.toWeb(__req);
      __fetch_options.duplex = "half";
    }

    // ============================================================
    // UPSTREAM REQUEST EXECUTION
    // ============================================================
    // Perform actual fetch to target server
    // This is the core proxying operation
    // All headers, body, and method are forwarded as-is (with filtering)
    // ============================================================
    const __upstream_res = await fetch(__url, __fetch_options);

    // Forward HTTP status code from upstream to client
    // This preserves semantic meaning (200, 404, 500, etc.)
    __res.statusCode = __upstream_res.status;

    // ============================================================
    // RESPONSE HEADER FORWARDING
    // ============================================================
    // Iterate through all headers from upstream response
    // Filter out transfer-encoding header (Node.js handles this)
    // Use try-catch to ignore invalid headers (some can't be set)
    // ============================================================
    const __resp_headers = __upstream_res.headers;
    for (const [__hk, __hv] of __resp_headers) {
      // Skip transfer-encoding as it's managed by the Node.js HTTP layer
      if (__hk.toLowerCase() === "transfer-encoding") continue;
      try { __res.setHeader(__hk, __hv); } catch {}
    }

    // ============================================================
    // RESPONSE BODY STREAMING
    // ============================================================
    // If upstream has a response body:
    //   1. Convert Web stream to Node.js readable stream (fromWeb)
    //   2. Pipeline directly to response object
    //   3. Pipeline automatically handles errors and backpressure
    // If no body, just end the response immediately
    // ============================================================
    if (__upstream_res.body) {
      await _stream_pipeline(_stream_readable.fromWeb(__upstream_res.body), __res);
    } else {
      __res.end();
    }
    
  // ============================================================
  // ERROR HANDLING PHASE
  // ============================================================
  // Catch any errors during the proxying process:
  //   - Network errors (ECONNREFUSED, ETIMEDOUT)
  //   - DNS resolution failures
  //   - TLS/certificate errors
  //   - Stream pipeline errors
  //   - Memory/backpressure issues
  // ============================================================
  } catch (__err) {
    // Log error with context prefix for debugging
    // Error details are NOT sent to client (security best practice)
    console.error("[relay]", __err);
    
    // Only send error response if headers haven't been sent yet
    // Prevents "Cannot set headers after they are sent" errors
    if (!__res.headersSent) {
      __res.statusCode = 502;  // Bad Gateway - upstream error
      __res.end("Bad Gateway: Tunnel Failed");
    }
  }
}
