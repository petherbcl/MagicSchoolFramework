"use strict";
// Development-only: real ArcaneMP executable + an isolated PostgreSQL WASM server.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const dgram = require("node:dgram");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { PGlite } = require("@electric-sql/pglite");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
const { Repository } = require("../server/database/repository");
const { loadConfig } = require("../server/config");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = 22000 + crypto.randomInt(2500), tcp = net.createServer(), udp = dgram.createSocket("udp4");
    try {
      await new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(port, "127.0.0.1", resolve); });
      return port;
    } catch { /* Try another unused TCP/UDP pair. */ }
    finally { if (tcp.listening) await new Promise(resolve => tcp.close(resolve)); try { udp.close(); } catch {} }
  }
  throw new Error("No free TCP/UDP port");
}
async function main() {
  const root = path.resolve(__dirname, "../../.."), resource = path.resolve(__dirname, "..");
  const directory = path.join(root, ".tmp", "ms-core-postgres-" + crypto.randomBytes(5).toString("hex"));
  fs.mkdirSync(path.join(directory, "resources"), { recursive: true });
  const destination = path.join(directory, "resources", "ms-core");
  fs.cpSync(resource, destination, { recursive: true, filter: file =>
    !path.relative(resource, file).split(path.sep).includes("node_modules") && !path.basename(file).startsWith(".env") });
  for (const entry of fs.readdirSync(path.join(resource, "node_modules"), { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith("@") && !entry.name.startsWith(".")) {
      fs.cpSync(path.join(resource, "node_modules", entry.name), path.join(destination, "node_modules", entry.name), { recursive: true });
    }
  }
  fs.cpSync(path.join(root, "resources", "my-gamemode"), path.join(directory, "resources", "my-gamemode"), { recursive: true });
  const probe = path.join(directory, "resources", "ms-smoke"); fs.mkdirSync(probe);
  fs.writeFileSync(path.join(probe, "package.json"), JSON.stringify({ name: "ms-smoke", mafiahub: { serverScripts: ["main.js"], resourceDependencies: ["ms-core"] } }));
  fs.writeFileSync(path.join(probe, "main.js"), `Events.on("resourceStart", async name => {
    if(name!=="ms-smoke") return; const core=Exports.get("ms-core","Core");
    if(core.version!=="0.3.0" || core.Users.isReady(12345)!==false || await core.Users.hasPermission(12345,"admin")!==false) throw new Error("Invalid core export");
    console.log("MS_CORE_POSTGRES_PROBE_OK"); });`);
  const engine = await PGlite.create(), server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 8 });
  let child, admin;
  try {
    await server.start();
    const connection = "postgresql://postgres:postgres@" + server.getServerConn() + "/postgres";
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MS_")));
    // Exercise automatic loading, using only isolated test credentials.
    fs.writeFileSync(path.join(destination, ".env"), "MS_DATABASE_URL=" + connection + "\nMS_DATABASE_POOL_SIZE=1\n");
    fs.writeFileSync(path.join(directory, "server.json"), JSON.stringify({ host: "127.0.0.1", port: await availablePort(), maxplayers: 2,
      password: crypto.randomBytes(24).toString("hex"), "package-secret": crypto.randomBytes(32).toString("hex"), "server-token": "" }));
    child = spawn(path.join(root, "ArcaneMPServer.exe"), [], { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const logPath = path.join(directory, "logs", "hogwarts-mp.log");
    const log = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : output;
    async function waitFor(predicate) {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && child.exitCode === null) { if (predicate(log())) return; await delay(100); }
      throw new Error("Runtime startup/reload failed: " + log().slice(-6000));
    }
    await waitFor(text => text.includes("MS_CORE_POSTGRES_PROBE_OK") && text.includes("Server successfully started"));
    admin = new Repository({ ...loadConfig({}), databaseUrl: connection, poolSize: 1 });
    const registered = await admin.register(null, crypto.createHash("sha256").update("isolated-smoke-account").digest("hex"), { hardwareId: "isolated-smoke-device" });
    if (registered.userId !== "1" || registered.allowlist !== "pending") throw new Error("Numeric PostgreSQL ID failed");
    await admin.setAllowlist("1", "approved", "console:smoke");
    child.stdin.write("ensure ms-core\n");
    await waitFor(text => (text.match(/MS_CORE_POSTGRES_PROBE_OK/g) || []).length >= 2);
    const exit = once(child, "exit"); child.stdin.end("stop\n");
    let alarm;
    const timeout = new Promise((resolve, reject) => { alarm = setTimeout(() => reject(new Error("Shutdown timeout")), 12000); alarm.unref(); });
    const [code] = await Promise.race([exit, timeout]).finally(() => clearTimeout(alarm));
    if (code !== 0 || log().toLowerCase().includes("[error]")) throw new Error(log().slice(-6000));
    console.log("PASS: PostgreSQL schema, numeric registration, external approval, native export, ensure and clean shutdown");
    console.log("Isolated runtime logs: " + directory);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    if (admin) await admin.close(); await server.stop(); await engine.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
