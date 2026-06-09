const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, systemPreferences, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const kimi = require("./kimi");

let win = null;
let clickThrough = false;

// ---- 内置服务端点(封装进 app,用户无需配置) ----
// 看屏 = Kimi(见 kimi.js,用用户填的 Kimi Key);语音 = heyi CosyVoice(开放端点,无需 key)。
// 用户只需在设置里填"自己生成的 Kimi Key",其余服务出厂即用。
const TTS_DEFAULTS = {
  url: "http://100.87.251.9:8092", // heyi-bj CosyVoice(Tailscale)
  model: "cosyvoice-v2",
  voice: "longxiaochun_v2",
};

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

// macOS 屏幕录制权限状态:granted / denied / restricted / not-determined / unknown
function screenAccessStatus() {
  if (process.platform !== "darwin") return "granted";
  try { return systemPreferences.getMediaAccessStatus("screen"); }
  catch (_) { return "unknown"; }
}

// 评估一帧的"信息量":平均亮度 + 简单方差,用来识别全黑/纯壁纸(无窗口=多半没授权)的空帧。
function frameStats(nativeImg) {
  try {
    const bmp = nativeImg.toBitmap(); // BGRA
    const size = nativeImg.getSize();
    const n = bmp.length / 4;
    if (!n) return { brightness: 0, variance: 0 };
    let sum = 0;
    // 采样降耗:最多取 ~4000 个像素
    const step = Math.max(1, Math.floor(n / 4000));
    let cnt = 0;
    const vals = [];
    for (let i = 0; i < n; i += step) {
      const o = i * 4;
      const lum = (bmp[o] + bmp[o + 1] + bmp[o + 2]) / 3;
      sum += lum; vals.push(lum); cnt++;
    }
    const mean = sum / cnt;
    let v = 0;
    for (const x of vals) v += (x - mean) * (x - mean);
    return { brightness: mean, variance: v / cnt, w: size.width, h: size.height };
  } catch (_) { return { brightness: 0, variance: 0 }; }
}

// 抓屏:遍历所有显示器,挑"信息量最大"的一帧(方差高=有窗口/内容),解决多屏只抓主屏的问题。
async function captureBestScreen() {
  const displays = screen.getAllDisplays();
  const maxEdge = displays.reduce((m, d) => Math.max(m, d.size.width, d.size.height), 1280);
  const scale = Math.min(1, 1280 / maxEdge);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(maxEdge * scale),
      height: Math.round(maxEdge * scale),
    },
  });
  if (!sources.length) return { image: null, empty: true };

  let best = null, bestScore = -1;
  for (const s of sources) {
    if (!s.thumbnail || s.thumbnail.isEmpty()) continue;
    const st = frameStats(s.thumbnail);
    // 内容丰富度评分:方差为主,亮度做轻微加权(避免纯黑得分为 0)
    const score = st.variance + Math.min(st.brightness, 60);
    if (score > bestScore) { bestScore = score; best = { source: s, st }; }
  }
  if (!best) return { image: null, empty: true };

  // 空帧判定:方差极低(全黑或纯色壁纸,通常意味着没拿到窗口内容/未授权)
  const empty = best.st.variance < 40;
  return { image: best.source.thumbnail.toDataURL(), empty, stats: best.st };
}

// 渲染进程请求抓全屏 → 返回 { image, empty, permission }
ipcMain.handle("capture-screen", async () => {
  const permission = screenAccessStatus();
  if (permission === "denied" || permission === "restricted") {
    return { image: null, empty: true, permission };
  }
  const hideForShot = win && !win.isDestroyed() && win.isVisible();
  if (hideForShot) {
    win.hide();
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  try {
    const r = await captureBestScreen();
    return { ...r, permission };
  } finally {
    if (hideForShot && win && !win.isDestroyed()) {
      win.showInactive();
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  }
});

// 屏幕录制权限:查询 + 打开系统设置面板(macOS)
ipcMain.handle("screen-permission", () => ({ status: screenAccessStatus() }));
ipcMain.handle("open-screen-settings", () => {
  if (process.platform === "darwin") {
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }
  return { ok: true };
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
ipcMain.handle("get-config", () => ({ kimiKey: userConfig.kimiKey || "", hasKey: !!userConfig.kimiKey }));
ipcMain.handle("set-config", (e, patch) => {
  userConfig = Object.assign({}, userConfig, patch || {});
  saveConfig(userConfig);
  return { ok: true, hasKey: !!userConfig.kimiKey };
});
ipcMain.handle("test-key", async (e, key) => {
  try { await kimi.testKey(key || userConfig.kimiKey); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

function postSpeech({ url, text, model, voice, speed }) {
  return new Promise((resolve, reject) => {
    const target = new URL((url || "").replace(/\/+$/, "") + "/v1/audio/speech");
    const lib = target.protocol === "https:" ? https : http;
    const body = JSON.stringify({
      model: model || "cosyvoice-v2",
      input: text || "",
      voice: voice || "alloy",
      response_format: "mp3",
      speed: Number(speed || 1),
    });
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`TTS ${res.statusCode}: ${buf.toString("utf8").slice(0, 200)}`));
        const type = res.headers["content-type"] || "audio/mpeg";
        resolve({ dataUrl: `data:${type};base64,${buf.toString("base64")}` });
      });
    });
    req.on("timeout", () => req.destroy(new Error("TTS 请求超时")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// 语音合成:服务端点已内置(heyi CosyVoice),渲染层只传文本/音色/语速。
ipcMain.handle("synthesize-speech", async (e, args) => {
  const a = args || {};
  try {
    return { ok: true, ...(await postSpeech({
      url: TTS_DEFAULTS.url,
      model: TTS_DEFAULTS.model,
      text: a.text,
      voice: a.voice || TTS_DEFAULTS.voice,
      speed: a.speed,
    })) };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ---- Kimi 代理:看屏解说 / 主动说话(在主进程发请求,避开浏览器 CORS) ----
ipcMain.handle("commentate", async (e, { image, homeTeam, history }) => {
  if (!userConfig.kimiKey) return { error: "no_key" };
  try { return { plan: await kimi.commentate(userConfig.kimiKey, image, homeTeam, history) }; }
  catch (err) { return { error: String(err.message || err) }; }
});
ipcMain.handle("proactive", async (e, { trigger, homeTeam, history }) => {
  if (!userConfig.kimiKey) return { error: "no_key" };
  try { return { plan: await kimi.proactive(userConfig.kimiKey, trigger, homeTeam, history) }; }
  catch (err) { return { error: String(err.message || err) }; }
});

app.whenReady().then(() => {
  userConfig = loadConfig();
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
