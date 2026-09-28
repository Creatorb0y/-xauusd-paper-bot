const express = require("express");
const path = require("path");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
const DATA_DIR = process.env.BROWSER_DATA_DIR || path.join(__dirname, "browser-data");

if (!API_KEY) {
  console.error("Missing TWELVE_DATA_API_KEY environment variable.");
  process.exit(1);
}

if (!DASHBOARD_TOKEN) {
  console.error("Missing DASHBOARD_TOKEN environment variable.");
  process.exit(1);
}

const app = express();
app.use(express.json());

function auth(req, res, next) {
  const token = req.query.token || req.get("x-dashboard-token") || "";
  if (token !== DASHBOARD_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

let browserContext;
let botPage;

async function startBrowser() {
  browserContext = await chromium.launchPersistentContext(DATA_DIR, {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  botPage = await browserContext.newPage();

  await botPage.goto(
    `http://127.0.0.1:${PORT}/bot.html?server=1`,
    { waitUntil: "domcontentloaded" }
  );

  await botPage.evaluate(({ apiKey }) => {
    const key = "xauusdPaperBot.v1";
    let saved = {};

    try {
      saved = JSON.parse(localStorage.getItem(key) || "{}");
    } catch {}

    saved.settings = {
      ...(saved.settings || {}),
      apiKey,
      tf: saved.settings?.tf || "15min",
      pollSec: Number(saved.settings?.pollSec || 30),
      kzFilter: saved.settings?.kzFilter ?? true,
      csvTz: Number(saved.settings?.csvTz || 0)
    };

    localStorage.setItem(key, JSON.stringify(saved));
  }, { apiKey: API_KEY });

  await botPage.reload({ waitUntil: "domcontentloaded" });
  await botPage.waitForTimeout(1500);

  console.log("Cloud paper bot browser started.");
}

async function safeState() {
  if (!botPage) {
    return { running: false, error: "Bot page not ready" };
  }

  return await botPage.evaluate(() => {
    const clean = (v) => JSON.parse(JSON.stringify(v));

    return {
      running: state.running,
      mode: state.mode,
      balance: state.balance,
      startBalance: state.startBalance,
      position: state.position ? clean(state.position) : null,
      trades: clean(state.trades).slice(-50),
      equity: clean(state.equity).slice(-200),
      candles: clean(state.candles).slice(-10),
      bias: state.bias,
      atr: state.atr,
      flowProxy: state.flowProxy,
      lastShift: state.lastShift ? clean(state.lastShift) : null,
      events: clean(state.events).slice(-20),
      activeFVGs: clean(state.activeFVGs),
      activeOBs: clean(state.activeOBs),
      sweeps: clean(state.sweeps),
      log: clean(state.log).slice(0, 40),
      lastEvalT: state.lastEvalT
    };
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/bot.html", (req, res) => {
  res.sendFile(path.join(__dirname, "xauusd-paper-bot.html"));
});

app.get("/api/state", auth, async (req, res) => {
  try {
    res.json(await safeState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/screenshot", auth, async (req, res) => {
  try {
    const png = await botPage.screenshot({ fullPage: true });
    res.type("png").send(png);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/api/health", auth, (req, res) => {
  res.json({
    ok: !!botPage,
    time: new Date().toISOString()
  });
});

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Dashboard listening on port ${PORT}`);

  try {
    await startBrowser();
  } catch (e) {
    console.error("Failed to start bot browser:", e);
    process.exit(1);
  }
});

async function shutdown() {
  console.log("Shutting down...");

  try {
    await browserContext?.close();
  } catch {}

  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
