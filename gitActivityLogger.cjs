const fs = require("fs");
const path = require("path");

let YAML;

try {
  YAML = require("yaml");
} catch (error) {
  console.error("Missing dependency: yaml");
  console.error("In GitHub Actions, this is installed using: npm install yaml --no-save");
  process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config", "git-logger.yml");

const CSV_COLUMNS = [
  "timestamp",
  "username",
  "email",
  "event",
  "branch",
  "commit_id",
  "pr_number",
];

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const rawConfig = fs.readFileSync(CONFIG_PATH, "utf8");
  return YAML.parse(rawConfig);
}

function readGitHubPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    throw new Error("Missing GITHUB_EVENT_PATH");
  }

  if (!fs.existsSync(eventPath)) {
    throw new Error(`GitHub event payload file not found: ${eventPath}`);
  }

  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function normalizeBranch(ref) {
  if (!ref) return "NA";

  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function normalizeCommitId(commitId) {
  if (!commitId) return "NA";

  const isDeletedRefSha = /^0+$/.test(commitId);
  return isDeletedRefSha ? "NA" : commitId;
}

function getUsername(payload) {
  return (
    payload.sender?.login ||
    payload.pull_request?.user?.login ||
    payload.pusher?.name ||
    process.env.GITHUB_ACTOR ||
    "NA"
  );
}

function getPushEmail(payload) {
  return (
    payload.head_commit?.author?.email ||
    payload.pusher?.email ||
    "NA"
  );
}

function buildAuditRecord(eventName, payload) {
  const baseRecord = {
    timestamp: new Date().toISOString(),
    username: getUsername(payload),
    email: "NA",
    event: "NA",
    branch: "NA",
    commit_id: "NA",
    pr_number: "NA",
  };

  if (eventName === "create") {
    if (payload.ref_type !== "branch") return null;

    return {
      ...baseRecord,
      event: "branch_created",
      branch: normalizeBranch(payload.ref),
    };
  }

  if (eventName === "delete") {
    if (payload.ref_type !== "branch") return null;

    return {
      ...baseRecord,
      event: "branch_deleted",
      branch: normalizeBranch(payload.ref),
    };
  }

  if (eventName === "push") {
    if (payload.deleted === true) return null;

    return {
      ...baseRecord,
      timestamp: payload.head_commit?.timestamp || baseRecord.timestamp,
      email: getPushEmail(payload),
      event: "push",
      branch: normalizeBranch(payload.ref),
      commit_id: normalizeCommitId(payload.after || payload.head_commit?.id),
    };
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request;

    if (!pr) return null;

    if (payload.action === "opened") {
      return {
        ...baseRecord,
        timestamp: pr.created_at || baseRecord.timestamp,
        event: "pull_request_created",
        branch: normalizeBranch(pr.head?.ref),
        commit_id: normalizeCommitId(pr.head?.sha),
        pr_number: String(pr.number || payload.number || "NA"),
      };
    }

    if (payload.action === "closed" && pr.merged === true) {
      return {
        ...baseRecord,
        timestamp: pr.merged_at || pr.closed_at || baseRecord.timestamp,
        event: "pull_request_merged",
        branch: normalizeBranch(pr.head?.ref),
        commit_id: normalizeCommitId(pr.merge_commit_sha || pr.head?.sha),
        pr_number: String(pr.number || payload.number || "NA"),
      };
    }

    if (payload.action === "closed" && pr.merged === false) {
      return {
        ...baseRecord,
        timestamp: pr.closed_at || baseRecord.timestamp,
        event: "pull_request_closed",
        branch: normalizeBranch(pr.head?.ref),
        commit_id: normalizeCommitId(pr.head?.sha),
        pr_number: String(pr.number || payload.number || "NA"),
      };
    }
  }

  return null;
}

function escapeCsvValue(value) {
  const finalValue =
    value === undefined || value === null || value === "" ? "NA" : String(value);

  if (
    finalValue.includes(",") ||
    finalValue.includes('"') ||
    finalValue.includes("\n") ||
    finalValue.includes("\r")
  ) {
    return `"${finalValue.replace(/"/g, '""')}"`;
  }

  return finalValue;
}

function toCsvRow(record) {
  return CSV_COLUMNS.map((column) => escapeCsvValue(record[column])).join(",");
}

function ensureCsvExists(outputPath) {
  const outputDir = path.dirname(outputPath);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    fs.writeFileSync(outputPath, `${CSV_COLUMNS.join(",")}\n`, "utf8");
  }
}

function appendRecord(outputPath, record) {
  ensureCsvExists(outputPath);
  fs.appendFileSync(outputPath, `${toCsvRow(record)}\n`, "utf8");
}

function main() {
  const config = readConfig();

  if (config.logging?.enabled !== true) {
    console.log("Git activity logging is disabled.");
    return;
  }

  const eventName = process.env.GITHUB_EVENT_NAME;

  if (!eventName) {
    throw new Error("Missing GITHUB_EVENT_NAME");
  }

  const payload = readGitHubPayload();
  const record = buildAuditRecord(eventName, payload);

  if (!record) {
    console.log(`No loggable activity found for event: ${eventName}`);
    return;
  }

  const enabledEvents = new Set(config.logging?.events || []);

  if (!enabledEvents.has(record.event)) {
    console.log(`Event disabled in config: ${record.event}`);
    return;
  }

  const outputPath = path.resolve(
    ROOT_DIR,
    config.logging?.output || "logs/git_activity.csv"
  );

  appendRecord(outputPath, record);

  console.log("Git activity logged successfully:");
  console.log(record);
}

main();