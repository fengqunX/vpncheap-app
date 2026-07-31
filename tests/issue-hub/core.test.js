"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  analyzeTaxonomy,
  desiredStatus,
  loadConfig,
  parseIssueEvent,
  syncIssueEvent
} = require("../../scripts/issue-hub/core");

const config = loadConfig(path.resolve(__dirname, "../../governance/issue-hub.json"));

function payload(action, { state = "open", labels = [] } = {}) {
  return {
    action,
    issue: {
      node_id: "I_issue",
      number: 42,
      state,
      labels: labels.map((name) => ({ name }))
    },
    repository: { name: "vpncheap-android", owner: { login: "fengqunX" } }
  };
}

class FakeClient {
  constructor({ state = "open", labels = [], itemStatus = "Triaged", itemExists = true } = {}) {
    this.issue = {
      type: "Issue",
      number: 42,
      state,
      labels,
      repository: "vpncheap-android",
      repositoryOwner: "fengqunX"
    };
    this.item = itemExists ? { id: "PVTI_item", status: itemStatus } : null;
    this.calls = [];
    this.project = {
      id: "PVT_project",
      fields: {
        nodes: [{
          __typename: "ProjectV2SingleSelectField",
          id: "PVTSSF_status",
          name: "Status",
          options: ["Inbox", "Needs info", "Triaged", "Planned", "In progress", "Verify", "Done"]
            .map((name) => ({ id: `option-${name}`, name }))
        }]
      }
    };
  }

  async getIssue() { this.calls.push(["getIssue"]); return this.issue; }
  async addIssueLabels(owner, repo, number, labels) { this.calls.push(["addIssueLabels", owner, repo, number, labels]); }
  async removeIssueLabel(owner, repo, number, label) { this.calls.push(["removeIssueLabel", owner, repo, number, label]); }
  async findProject() { this.calls.push(["findProject"]); return this.project; }
  async findIssueProjectItem() { this.calls.push(["findIssueProjectItem"]); return this.item; }
  async addProjectItem() { this.calls.push(["addProjectItem"]); this.item = { id: "PVTI_added", status: null }; return this.item; }
  async updateProjectStatus(project, itemId, status) { this.calls.push(["updateProjectStatus", project.id, itemId, status]); }
}

test("close sets Done", async () => {
  const client = new FakeClient({ state: "closed", itemStatus: "Verify" });
  const result = await syncIssueEvent({ payload: payload("closed", { state: "closed" }), config, client });
  assert.equal(result.status, "Done");
  assert.equal(result.statusChanged, true);
  assert.deepEqual(client.calls.at(-1), ["updateProjectStatus", "PVT_project", "PVTI_item", "Done"]);
});

test("reopen sets Inbox", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: defaults, itemStatus: "Done" });
  const result = await syncIssueEvent({ payload: payload("reopened"), config, client });
  assert.equal(result.status, "Inbox");
  assert.deepEqual(client.calls.at(-1), ["updateProjectStatus", "PVT_project", "PVTI_item", "Inbox"]);
});

test("taxonomy-conflict reopen sets Needs info", async () => {
  const client = new FakeClient({
    state: "open",
    labels: ["platform:android", "runtime:native", "runtime:flutter", "surface:phone"],
    itemStatus: "Done"
  });
  const result = await syncIssueEvent({ payload: payload("reopened"), config, client });
  assert.equal(result.taxonomyConflict, true);
  assert.deepEqual(result.taxonomyConflicts, ["Runtime"]);
  assert.equal(result.status, "Needs info");
  assert(client.calls.some((call) => call[0] === "addIssueLabels" && call[4].includes("taxonomy-conflict")));
  assert.deepEqual(client.calls.at(-1), ["updateProjectStatus", "PVT_project", "PVTI_item", "Needs info"]);
});

test("unknown and missing taxonomy values remain blank without conflict", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const analysis = analyzeTaxonomy([...defaults, "some-unknown-label"], config.taxonomy);
  assert.equal(analysis.hasConflict, false);
  assert.equal(desiredStatus({ action: "opened", issueState: "open", hasTaxonomyConflict: false }), "Inbox");
});

test("multiple Platform and Surface labels are valid", () => {
  const analysis = analyzeTaxonomy([
    "platform:ios", "platform:macos", "runtime:native", "surface:phone", "surface:desktop"
  ], config.taxonomy);
  assert.equal(analysis.hasConflict, false);
});

test("taxonomy matching is case-insensitive", () => {
  const analysis = analyzeTaxonomy([
    "Platform:Android", "Runtime:Native", "RUNTIME:FLUTTER", "Surface:Phone"
  ], config.taxonomy);
  assert.equal(analysis.hasConflict, true);
  assert.deepEqual(analysis.conflicts, ["Runtime"]);
});

test("case-only label drift does not add a duplicate repository default", async () => {
  const client = new FakeClient({
    state: "open",
    labels: ["Platform:Android", "Runtime:Native", "Surface:Phone", "SURFACE:TABLET"],
    itemStatus: "Inbox"
  });
  const result = await syncIssueEvent({ payload: payload("opened"), config, client });
  assert.deepEqual(result.labelsAdded, []);
  assert.equal(client.calls.some((call) => call[0] === "addIssueLabels"), false);
});

test("labeled event with no conflict leaves Status unchanged", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: defaults, itemStatus: "Triaged" });
  const result = await syncIssueEvent({ payload: payload("labeled"), config, client });
  assert.equal(result.status, null);
  assert.equal(result.statusChanged, false);
  assert.equal(client.calls.some((call) => call[0] === "updateProjectStatus"), false);
});

test("out-of-order closed event cannot overwrite a live reopened issue", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: defaults, itemStatus: "Inbox" });
  const result = await syncIssueEvent({ payload: payload("closed", { state: "closed" }), config, client });
  assert.equal(result.status, null);
  assert.equal(result.statusChanged, false);
});

test("existing Inbox replay is a no-op", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: defaults, itemStatus: "Inbox" });
  const result = await syncIssueEvent({ payload: payload("opened"), config, client });
  assert.equal(result.status, null);
  assert.equal(result.statusChanged, false);
  assert.equal(client.calls.some((call) => call[0] === "updateProjectStatus"), false);
});

test("stale opened, reopened, and transferred replays do not downgrade active work", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const cases = [
    ["opened", "Triaged"],
    ["reopened", "Planned"],
    ["transferred", "In progress"]
  ];
  for (const [action, itemStatus] of cases) {
    const client = new FakeClient({ state: "open", labels: defaults, itemStatus });
    const result = await syncIssueEvent({ payload: payload(action), config, client });
    assert.equal(result.status, null, `${action} must preserve ${itemStatus}`);
    assert.equal(result.statusChanged, false, `${action} must not write Status`);
    assert.equal(client.calls.some((call) => call[0] === "updateProjectStatus"), false);
  }
});

test("new or status-less Project item enters Inbox", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  for (const options of [{ itemExists: false }, { itemStatus: null }]) {
    const client = new FakeClient({ state: "open", labels: defaults, ...options });
    const result = await syncIssueEvent({ payload: payload("opened"), config, client });
    assert.equal(result.status, "Inbox");
    assert.equal(result.statusChanged, true);
  }
});

test("assigned event bootstraps a new open item with repository defaults and Inbox", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: [], itemExists: false });
  const result = await syncIssueEvent({ payload: payload("assigned"), config, client });
  assert.equal(result.itemAdded, true);
  assert.equal(result.status, "Inbox");
  assert.deepEqual(result.labelsAdded, defaults);
  assert(client.calls.some((call) => call[0] === "addIssueLabels" &&
    defaults.every((label) => call[4].includes(label))));
  assert.deepEqual(client.calls.at(-1), ["updateProjectStatus", "PVT_project", "PVTI_added", "Inbox"]);
});

test("caller-late unassigned replay converges a status-less open item", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: [], itemStatus: null });
  const result = await syncIssueEvent({ payload: payload("unassigned"), config, client });
  assert.equal(result.itemAdded, false);
  assert.equal(result.status, "Inbox");
  assert.deepEqual(result.labelsAdded, defaults);
  assert.deepEqual(client.calls.at(-1), ["updateProjectStatus", "PVT_project", "PVTI_item", "Inbox"]);
});

test("assigned event repairs Done when the live issue is open", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: defaults, itemStatus: "Done" });
  const result = await syncIssueEvent({ payload: payload("assigned"), config, client });
  assert.equal(result.status, "Inbox");
  assert.equal(result.statusChanged, true);
  assert.deepEqual(client.calls.at(-1), ["updateProjectStatus", "PVT_project", "PVTI_item", "Inbox"]);
});

test("non-taxonomy replay fills defaults without downgrading Verify", async () => {
  const defaults = config.taxonomy.repositories["vpncheap-android"].defaults;
  const client = new FakeClient({ state: "open", labels: [], itemStatus: "Verify" });
  const result = await syncIssueEvent({ payload: payload("assigned"), config, client });
  assert.equal(result.status, null);
  assert.equal(result.statusChanged, false);
  assert.deepEqual(result.labelsAdded, defaults);
  assert.equal(client.calls.some((call) => call[0] === "updateProjectStatus"), false);
});

test("pull requests are excluded before any API call", async () => {
  const event = payload("opened");
  event.issue.pull_request = { url: "https://api.github.com/pulls/1" };
  const client = new FakeClient();
  const result = await syncIssueEvent({ payload: event, config, client });
  assert.equal(result.ignored, true);
  assert.match(result.reason, /Pull requests/);
  assert.deepEqual(client.calls, []);
});

test("unsupported event action is ignored", () => {
  const result = parseIssueEvent(payload("edited"));
  assert.equal(result.ignored, true);
  assert.match(result.reason, /Unsupported/);
});
