const http = require("http");
const fs = require("fs");

const PORT = 7860;
const startTime = Date.now();
const SYNC_STATUS_FILE = "/tmp/sync-status.json";

function readSyncStatus() {
  try {
    if (fs.existsSync(SYNC_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(SYNC_STATUS_FILE, "utf8"));
    }
  } catch {}
  return {
    status: "unknown",
    last_sync_time: null,
    last_error: null,
    sync_count: 0,
  };
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime,
      uptimeHuman: formatUptime(uptime),
      timestamp: new Date().toISOString(),
      sync: readSyncStatus(),
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Health server listening on port ${PORT}`);
});
