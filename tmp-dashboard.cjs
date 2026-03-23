const http = require("http");
const fs = require("fs");
const path = require("path");
const DASH = path.join("Q:\\work\\squad-fork\\packages\\squad-cli\\src\\dashboard\\index.html");
const PORT = 3850;
let live = null;
let agentMessages = {};

function readBody(req) { return new Promise(r => { let b=""; req.on("data",c=>b+=c); req.on("end",()=>r(b)); }); }

const server = http.createServer(async (req, res) => {
  const cors = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST","Access-Control-Allow-Headers":"Content-Type"};
  if (req.method==="OPTIONS") { res.writeHead(204,cors); res.end(); return; }

  if (req.url==="/"||req.url==="/index.html") { res.writeHead(200,{"Content-Type":"text/html"}); fs.createReadStream(DASH).pipe(res); }
  else if (req.url==="/api/status") {
    const s = live || {running:false,activeSessions:0,agents:[],recentEvents:[]};
    res.writeHead(200,cors); res.end(JSON.stringify({...s,sessionCount:s.activeSessions}));
  }
  else if (req.url==="/api/push"&&req.method==="POST") {
    try { live=JSON.parse(await readBody(req)); res.writeHead(200,cors); res.end("ok"); } catch { res.writeHead(400,cors); res.end("bad"); }
  }
  else if (req.url==="/api/push-messages"&&req.method==="POST") {
    try { const d=JSON.parse(await readBody(req)); agentMessages[d.agentName]=d.messages; res.writeHead(200,cors); res.end("ok"); } catch { res.writeHead(400,cors); res.end("bad"); }
  }
  else if (req.url?.startsWith("/api/sessions/")&&req.method==="GET") {
    const name=decodeURIComponent(req.url.split("/api/sessions/")[1]?.split("?")[0]||"");
    res.writeHead(200,cors); res.end(JSON.stringify({agentName:name,messages:agentMessages[name]||[]}));
  }
  else { res.writeHead(404); res.end("Not found"); }
});
server.listen(PORT, () => console.log("Squad Dashboard: http://localhost:" + PORT));
