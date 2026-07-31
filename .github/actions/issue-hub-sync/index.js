"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, syncIssueEvent } = require("../../../scripts/issue-hub/core");
const { GitHubClient } = require("../../../scripts/issue-hub/github-client");

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${value ?? ""}\n`, "utf8");
}

async function main({ env = process.env, Client = GitHubClient } = {}) {
  const token = env.INPUT_TOKEN;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!token) throw new Error("Action input token is required");
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");

  const config = loadConfig(path.resolve(__dirname, "../../../governance/issue-hub.json"));
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const client = new Client({ token });
  const viewer = await client.getViewer();
  if (viewer.login !== config.project.owner) {
    throw new Error(`Authenticated GitHub user is ${viewer.login}; expected ${config.project.owner}`);
  }
  const result = await syncIssueEvent({
    payload,
    eventName: env.GITHUB_EVENT_NAME,
    config,
    client
  });

  if (result.ignored) {
    console.log(`Issue hub sync skipped: ${result.reason}`);
    setOutput("status", "");
    setOutput("project-item-id", "");
    return;
  }

  console.log(JSON.stringify({
    repository: result.repository,
    issueNumber: result.issueNumber,
    itemAdded: result.itemAdded,
    status: result.status,
    statusChanged: result.statusChanged,
    taxonomyConflict: result.taxonomyConflict,
    labelsAdded: result.labelsAdded,
    labelsRemoved: result.labelsRemoved
  }));
  setOutput("status", result.status);
  setOutput("project-item-id", result.itemId);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Issue hub sync failed: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
