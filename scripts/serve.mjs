// docs/ をローカルで表示するための簡易サーバー
// 使い方: node scripts/serve.mjs  → http://localhost:8080
// 同じ Wi-Fi のスマホからも http://<このPCのIPアドレス>:8080 で見られる

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const PORT = Number(process.env.PORT || 8080);
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };

http
  .createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(DOCS, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath);
    if (!file.startsWith(DOCS)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": (TYPES[path.extname(file)] || "application/octet-stream") + "; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
    for (const ifs of Object.values(os.networkInterfaces()))
      for (const i of ifs || []) if (i.family === "IPv4" && !i.internal) console.log(`http://${i.address}:${PORT}  (同じネットワークの端末から)`);
  });
