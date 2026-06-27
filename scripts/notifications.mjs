function buildFailureMessage({ error, message, runUrl, repository } = {}) {
  if (message) return message;

  return [
    "Coze 每日积分任务失败。",
    error ? `原因：${error?.message || String(error)}` : "",
    repository ? `仓库：${repository}` : "",
    runUrl ? `运行记录：${runUrl}` : ""
  ].filter(Boolean).join("\n");
}

export async function notifyFailure(options = {}) {
  const title = options.title || "Coze每日积分失败";
  const content = buildFailureMessage(options);

  const results = await Promise.all([
    sendBark(title, content),
    sendPushPlus(title, content)
  ]);

  return results.some(Boolean);
}

async function sendBark(title, content) {
  const base = normalizeBarkUrl(process.env.BARK_PUSH_URL || "");
  if (!base) {
    console.log("BARK_PUSH_URL is not set; skip Bark notification.");
    return false;
  }

  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`;
  const response = await fetch(url).catch((error) => {
    console.error(`Bark notification failed: ${error.message}`);
    return null;
  });

  if (response && !response.ok) {
    console.error(`Bark notification returned HTTP ${response.status}: ${await response.text()}`);
    return false;
  }

  if (!response) return false;
  console.log("Bark notification sent.");
  return true;
}

async function sendPushPlus(title, content) {
  const token = (process.env.PUSHPLUS_TOKEN || "").trim();
  if (!token) {
    console.log("PUSHPLUS_TOKEN is not set; skip pushplus notification.");
    return false;
  }

  const payload = {
    token,
    title,
    content,
    template: process.env.PUSHPLUS_TEMPLATE || "txt"
  };

  const topic = (process.env.PUSHPLUS_TOPIC || "").trim();
  if (topic) {
    payload.topic = topic;
  }

  const response = await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }).catch((error) => {
    console.error(`pushplus notification failed: ${error.message}`);
    return null;
  });

  if (!response) return false;

  const text = await response.text();
  if (!response.ok) {
    console.error(`pushplus notification returned HTTP ${response.status}: ${text}`);
    return false;
  }

  const result = parseJson(text);
  if (result && typeof result.code !== "undefined" && result.code !== 200) {
    console.error(`pushplus notification returned code ${result.code}: ${result.msg || text}`);
    return false;
  }

  console.log("pushplus notification sent.");
  return true;
}

function normalizeBarkUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
