import { notifyFailure } from "./notifications.mjs";

const runUrl = process.env.RUN_URL || (
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : ""
);

await notifyFailure({
  title: "Coze每日积分失败",
  message: [
    "GitHub Actions 运行失败。",
    process.env.REPOSITORY || process.env.GITHUB_REPOSITORY
      ? `仓库：${process.env.REPOSITORY || process.env.GITHUB_REPOSITORY}`
      : "",
    runUrl ? `运行记录：${runUrl}` : ""
  ].filter(Boolean).join("\n")
});
