const http = require("http");
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join("Q:\\work\\Portal\\AAPT-APIM-Portal\\.squad\\.runtime\\server-state.json");
const DASH_HTML = path.join("Q:\\work\\squad-fork\\packages\\squad-cli\\src\\dashboard\\index.html");
const PORT = 3850;

let liveStatus = null;

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    return {
      running: true, started: true,
      activeSessions: state.sessions ? state.sessions.length : 0,
      agents: (state.sessions || []).map(s => ({
        agentName: s.agentName, sessionId: s.sessionId,
        charterRole: s.status || "active",
        createdAt: s.createdAt, lastActiveAt: s.lastMessageAt
      })),
      poolCapacity: state.poolCapacity || 0,
      connectedToHost: true,
      uptime: state.serverStartedAt ? Math.floor((Date.now() - new Date(state.serverStartedAt).getTime()) / 1000) : 0,
      recentEvents: liveStatus ? liveStatus.recentEvents || [] : [],
      totalEvents: liveStatus ? liveStatus.totalEvents || 0 : 0,
    };
  } catch { return null; }
}

const server = http.createServer((req, res) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(DASH_HTML).pipe(res);
  } else if (req.url === "/api/status") {
    const status = liveStatus || readState() || { running: false, activeSessions: 0, agents: [], recentEvents: [] };
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ...status, sessionCount: status.activeSessions }));
  } else if (req.url === "/api/push" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { liveStatus = JSON.parse(body); res.writeHead(200, cors); res.end("ok"); }
      catch { res.writeHead(400, cors); res.end(JSON.stringify({error:"bad json"})); }
    });
  } else { res.writeHead(404); res.end("Not found"); }
});

server.listen(PORT, () => console.log("Squad Dashboard: http://localhost:" + PORT));
