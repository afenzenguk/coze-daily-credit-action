import fs from "node:fs/promises";
import sodium from "libsodium-wrappers";

const secretName = process.env.COZE_SECRET_NAME || "COZE_STORAGE_STATE_JSON";
const statePath = process.env.UPDATED_STORAGE_STATE_PATH || "artifacts/storage_state.updated.json";
const token = process.env.GH_PAT || "";
const repository = process.env.GITHUB_REPOSITORY || "";

async function main() {
  if (!token) {
    console.log("GH_PAT is not set; skipping GitHub secret update.");
    return;
  }
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is missing.");
  }

  const value = await fs.readFile(statePath, "utf8");
  JSON.parse(value);

  const publicKey = await github("GET", `/repos/${repository}/actions/secrets/public-key`);
  const encryptedValue = await encryptSecret(publicKey.key, value);

  await github("PUT", `/repos/${repository}/actions/secrets/${secretName}`, {
    encrypted_value: encryptedValue,
    key_id: publicKey.key_id
  });

  console.log(`Updated repository secret ${secretName}.`);
}

async function encryptSecret(publicKey, value) {
  await sodium.ready;
  const binaryKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const binaryValue = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(binaryValue, binaryKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

async function github(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "coze-daily-credit-action",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} failed: HTTP ${response.status} ${text}`);
  }
  return payload;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
