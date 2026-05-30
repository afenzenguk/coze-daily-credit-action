import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const STORAGE_STATE_PATH = path.join(ARTIFACT_DIR, "storage_state.json");
const UPDATED_STORAGE_STATE_PATH = path.join(ARTIFACT_DIR, "storage_state.updated.json");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "failure.png");

const DEFAULT_TARGET_URL = "https://www.coze.cn/home";
const targetUrl = process.env.COZE_TARGET_URL || DEFAULT_TARGET_URL;
const barkPushUrl = normalizeBarkUrl(process.env.BARK_PUSH_URL || "");
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";

const DEFAULT_CLICK_TEXTS = [
  "领取",
  "签到",
  "免费积分",
  "每日",
  "去领取",
  "立即领取",
  "Get",
  "Claim"
];

async function main() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await materializeStorageState();

  const launchOptions = {
    headless: process.env.HEADLESS !== "false"
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
  }

  const browser = await chromium.launch(launchOptions);

  let context;
  try {
    context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      storageState: STORAGE_STATE_PATH
    });

    const page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000));

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    await assertLoggedIn(page);

    await clickLikelyClaimControls(page);
    await settle(page);
    await assertLoggedIn(page);

    await context.storageState({ path: UPDATED_STORAGE_STATE_PATH });
    console.log(`Coze daily visit completed: ${targetUrl}`);
    console.log(`Updated storage state written to ${UPDATED_STORAGE_STATE_PATH}`);
  } catch (error) {
    await captureFailure(context, error);
    await notifyFailure(error);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function materializeStorageState() {
  const storageStateJson = process.env.COZE_STORAGE_STATE_JSON?.trim();
  const cookiesJson = process.env.COZE_COOKIES_JSON?.trim();

  if (storageStateJson) {
    const storageState = JSON.parse(storageStateJson);
    validateStorageState(storageState);
    await fs.writeFile(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), "utf8");
    return;
  }

  if (!cookiesJson) {
    throw new Error("Missing COZE_STORAGE_STATE_JSON or COZE_COOKIES_JSON secret.");
  }

  const rawCookies = JSON.parse(cookiesJson);
  const cookies = Array.isArray(rawCookies) ? rawCookies : rawCookies.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("COZE_COOKIES_JSON must be a non-empty cookie array or a storage state object with cookies.");
  }

  const normalizedCookies = cookies.map(normalizeCookie).filter((cookie) => cookie.name && cookie.value);
  if (normalizedCookies.length === 0) {
    throw new Error("COZE_COOKIES_JSON did not contain usable cookies.");
  }

  const storageState = {
    cookies: normalizedCookies,
    origins: Array.isArray(rawCookies.origins) ? rawCookies.origins : []
  };
  await fs.writeFile(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), "utf8");
}

function validateStorageState(storageState) {
  if (!storageState || !Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
    throw new Error("COZE_STORAGE_STATE_JSON must be a Playwright storage_state object with cookies.");
  }
}

function normalizeCookie(cookie) {
  const normalized = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: cookie.domain || ".coze.cn",
    path: cookie.path || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite)
  };

  if (typeof cookie.expires === "number") {
    normalized.expires = cookie.expires;
  } else if (typeof cookie.expirationDate === "number") {
    normalized.expires = cookie.expirationDate;
  }

  return normalized;
}

function normalizeSameSite(value) {
  if (["Strict", "Lax", "None"].includes(value)) {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "strict") return "Strict";
    if (lower === "lax") return "Lax";
    if (lower === "none" || lower === "no_restriction") return "None";
  }
  return "Lax";
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/login|passport|sso|signin/i.test(url)) {
    throw new Error(`Login appears expired; current URL is ${url}`);
  }

  const loginControls = await page
    .getByText(/登录|注册|Sign in|Log in/i)
    .count()
    .catch(() => 0);

  const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 2000);
  const hasLoggedOutHint = /请登录|未登录|登录后|Sign in|Log in/i.test(bodyText);
  if (loginControls > 0 && hasLoggedOutHint) {
    throw new Error("Login appears expired; login text was detected on the page.");
  }
}

async function clickLikelyClaimControls(page) {
  const configuredTexts = (process.env.COZE_CLICK_TEXTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const texts = configuredTexts.length ? configuredTexts : DEFAULT_CLICK_TEXTS;

  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    await locator.click({ timeout: 5000 }).catch(() => {});
    console.log(`Clicked possible claim control: ${text}`);
    return;
  }

  console.log("No claim-like control found; page visit is treated as the daily action.");
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 5000));
}

async function captureFailure(context, error) {
  const page = context?.pages()?.[0];
  if (!page) return;

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(path.join(ARTIFACT_DIR, "failure.html"), html, "utf8").catch(() => {});
  }
  console.error(error);
}

async function notifyFailure(error) {
  if (!barkPushUrl) return;

  const message = [
    `Coze daily action failed.`,
    `Reason: ${error?.message || String(error)}`,
    runUrl ? `Run: ${runUrl}` : ""
  ].filter(Boolean).join("\n");

  const url = `${barkPushUrl}/${encodeURIComponent("Coze每日积分失败")}/${encodeURIComponent(message)}`;
  const response = await fetch(url).catch((fetchError) => {
    console.error(`Bark notification failed: ${fetchError.message}`);
    return null;
  });

  if (response && !response.ok) {
    console.error(`Bark notification returned HTTP ${response.status}`);
  }
}

function normalizeBarkUrl(url) {
  return url.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
