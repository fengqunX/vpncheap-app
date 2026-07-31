"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { main } = require("../../.github/actions/issue-hub-sync/index");

test("event action rejects a token for the wrong GitHub user before any write path", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "issue-hub-action-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, "event.json");
  fs.writeFileSync(eventPath, "{}", "utf8");
  const calls = [];

  class WrongIdentityClient {
    constructor({ token }) {
      assert.equal(token, "wrong-user-token");
    }

    async getViewer() {
      calls.push("getViewer");
      return { login: "wrong-account" };
    }

    async getIssue() {
      calls.push("getIssue");
      throw new Error("write path must not be reached");
    }
  }

  await assert.rejects(() => main({
    env: {
      INPUT_TOKEN: "wrong-user-token",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "issues"
    },
    Client: WrongIdentityClient
  }), /Authenticated GitHub user is wrong-account; expected fengqunX/);
  assert.deepEqual(calls, ["getViewer"]);
});
