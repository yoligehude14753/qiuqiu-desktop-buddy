const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const kimi = require("./kimi");

let win = null;
let clickThrough = false;

// 语音:CosyVoice2(longxiaochun_v2),与 6/7 北京腔版同款音色。
// 双路:公网网关(任何用户可达) + Tailscale 直连(本机代理劫持 *.yoliyoli.uk 时兜底),失败自动切换。
const TTS_TOKEN = "__GATEWAY_TOKEN_REMOVED__";
const TTS_ROUTES = [
  { tls: true, host: "tts2.yoliyoli.uk", port: 443, headers: { Authorization: `Bearer ${TTS_TOKEN}` } },
  { tls: false, host: "100.87.251.9", port: 8092, headers: {} },
];
let ttsRouteIdx = 0;
const TTS = { model: "cosyvoice-v2", voice: "longxiaochun_v2" };
function synthOnce(route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = route.tls ? https : http;
    const req = lib.request({
      hostname: route.host, port: route.port, path: "/v1/audio/speech", method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, route.headers),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`TTS ${res.statusCode}`));
        const type = res.headers["content-type"] || "audio/mpeg";
        resolve(`data:${type};base64,${buf.toString("base64")}`);
      });
    });
    req.on("timeout", () => req.destroy(new Error("TTS 超时")));
    req.on("error", reject);
    req.write(body); req.end();
  });
}
async function synthSpeech(text) {
  if (!text) return null;
  const body = JSON.stringify({ model: TTS.model, input: text, voice: TTS.voice, response_format: "mp3" });
  for (let attempt = 0; attempt < TTS_ROUTES.length; attempt++) {
    const r = TTS_ROUTES[ttsRouteIdx];
    try { return await synthOnce(r, body, 15000); }
    catch (e) {
      ttsRouteIdx = (ttsRouteIdx + 1) % TTS_ROUTES.length;
      if (attempt === TTS_ROUTES.length - 1) throw e;
    }
  }
}

// ---- 用户配置(存到 userData/config.json),含 Kimi Key ----
function configPath() { return path.join(app.getPath("userData"), "config.json"); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); }
  catch (_) { return { kimiKey: "" }; }
}
function saveConfig(cfg) {
  try { fs.mkdirSync(app.getPath("userData"), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); return true; }
  catch (e) { console.error("保存配置失败", e); return false; }
}
let userConfig = { kimiKey: "" };

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const W = 320, H = 460;

  win = new BrowserWindow({
    width: W,
    height: H,
    x: sw - W - 24,
    y: 80,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 始终浮在最上层(包括全屏应用之上)
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// 召回:把窗口拉回主屏右上角、取消穿透、置顶并高亮,解决"找不到/点不到"。
function recallWindow() {
  if (!win) return;
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const [W, H] = win.getSize();
  win.setPosition(sw - W - 24, 80);
  setClickThrough(false);
  win.setAlwaysOnTop(true, "screen-saver");
  win.show();
  win.focus();
  win.webContents.send("recalled");
}

function setClickThrough(value) {
  clickThrough = Boolean(value);
  if (!win) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  win.webContents.send("click-through-changed", clickThrough);
}

function toggleClickThrough() {
  setClickThrough(!clickThrough);
}

// 渲染进程请求抓全屏 → 返回一帧 dataURL
// ~900px + JPEG:实测 1280 PNG 在 Qwen3-VL 上要 6-13s,900 JPEG 只要 ~2s,质量足够读清。
ipcMain.handle("capture-screen", async () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const scale = Math.min(1, 900 / Math.max(width, height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
  });
  if (!sources.length) return null;
  const jpeg = sources[0].thumbnail.toJPEG(75);
  return "data:image/jpeg;base64," + jpeg.toString("base64");
});

// 运行日志:写到 userData/buddy.log(自动截断),排查"说了啥/多快/为什么不说"。
function logPath() { return path.join(app.getPath("userData"), "buddy.log"); }
ipcMain.on("buddy-log", (e, line) => {
  try {
    const f = logPath();
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    fs.appendFileSync(f, `${stamp} ${String(line).slice(0, 400)}\n`);
    if (fs.statSync(f).size > 256 * 1024) fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(-128 * 1024));
  } catch (_) {}
});

// 鼠标穿透开关(气泡区域可点,数字人区域可拖)
ipcMain.on("set-ignore-mouse", (e, ignore) => {
  setClickThrough(ignore);
});

ipcMain.on("toggle-click-through", () => toggleClickThrough());
ipcMain.on("toggle-running", () => {
  if (win) win.webContents.send("toggle-running");
});
ipcMain.on("quit-app", () => app.quit());

// ---- 配置:读 / 写 / 测 Key ----
ipcMain.handle("get-config", () => ({ kimiKey: userConfig.kimiKey || "", hasKey: !!userConfig.kimiKey, version: app.getVersion() }));
ipcMain.handle("set-config", (e, patch) => {
  userConfig = Object.assign({}, userConfig, patch || {});
  saveConfig(userConfig);
  return { ok: true, hasKey: !!userConfig.kimiKey };
});
ipcMain.handle("test-key", async (e, arg) => {
  const provider = (arg && arg.provider) || "qwen3";
  const key = (arg && arg.key) || (typeof arg === "string" ? arg : "") || userConfig.kimiKey;
  try { await kimi.testProvider({ provider, kimiKey: key }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ---- Kimi 代理:看屏解说 / 主动说话(在主进程发请求,避开浏览器 CORS) ----
ipcMain.handle("commentate", async (e, { image, homeTeam, history, provider, first, nudge, persona }) => {
  const prov = provider || "qwen3";
  if (prov === "k2.6" && !userConfig.kimiKey) return { error: "no_key" };
  try {
    const plan = await kimi.commentate({ provider: prov, kimiKey: userConfig.kimiKey, image, homeTeam, history, first, nudge, persona });
    let audio = null;
    if (plan && plan.comment) { try { audio = await synthSpeech(plan.comment); } catch (_) {} }
    return { plan, audio };
  } catch (err) { return { error: String(err.message || err) }; }
});

app.whenReady().then(() => {
  userConfig = loadConfig();
  // 启动时记录版本与启动方式,排查"跑的是哪个构建"
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString().replace("T", " ").slice(0, 19)} === app v${app.getVersion()} started (packaged=${app.isPackaged}) ===\n`);
  } catch (_) {}
  createWindow();
  globalShortcut.register("CommandOrControl+Shift+K", toggleClickThrough);
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (win) win.webContents.send("toggle-running");
  });
  globalShortcut.register("CommandOrControl+Shift+J", recallWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 再次双击/启动:把已有窗口召回到前台;窗口丢了就重建。
app.on("second-instance", () => {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  recallWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
