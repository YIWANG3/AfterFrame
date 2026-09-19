// Dedicated localhost HTTP server for <video>. Chromium's media element refuses
// to load from the custom media:// scheme even with stream:true (it uses a
// different loader than fetch), but plays HTTP range streams perfectly. Images
// keep media://; only video uses this. Every path is allowlist-checked exactly
// like media://. Extracted from main.js (review 2026-09-16 §2).

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const VIDEO_MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
};

// Starts listening on an ephemeral port right away; port() is 0 until then.
function createMediaHttpServer({ allowlist }) {
  let port = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/media") { res.writeHead(404).end(); return; }
      const filePath = path.resolve(u.searchParams.get("path") || "");
      if (!(await allowlist.isAllowedMediaPathLoaded(filePath))) { res.writeHead(403).end(); return; }
      if (!fs.existsSync(filePath)) { res.writeHead(404).end(); return; }
      const stat = fs.statSync(filePath);
      const mime = VIDEO_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        res.writeHead(206, {
          "Content-Type": mime,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch {
      try { res.writeHead(500).end(); } catch { /* ignore */ }
    }
  });
  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    console.log("[media-http] listening on 127.0.0.1:" + port);
  });
  return { port: () => port, server };
}

module.exports = { createMediaHttpServer, VIDEO_MIME };
