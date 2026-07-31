"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../../scripts/issue-hub/core");
const {
  FoundationReconciler,
  isForbiddenWorkflowLabel,
  parseArgs,
  taxonomyLabelDefinitions
} = require("../../scripts/issue-hub/reconcile");

const config = loadConfig(path.resolve(__dirname, "../../governance/issue-hub.json"));

test("foundation contains the frozen fields and saved views", () => {
  assert.deepEqual(config.project.fields.map((field) => field.name), [
    "Status", "Priority", "Customer reports count", "Last report date"
  ]);
  assert.deepEqual(config.project.views.map((view) => view.name), [
    "CEO 看板", "Native 矩阵", "Hot issues", "待补充", "Release blockers"
  ]);
});

test("foundation governs exactly the frozen twelve repositories", () => {
  assert.deepEqual(Object.keys(config.taxonomy.repositories), [
    "vpncheap",
    "vpncheap-android",
    "vpncheap-android-tv",
    "vpncheap-app",
    "vpncheap-apple-native",
    "vpncheap-apple-tv",
    "vpncheap-download",
    "vpncheap-ios",
    "vpncheap-macos",
    "vpncheap-maintained",
    "vpncheap-web",
    "vpncheap-windows"
  ]);
});

test("taxonomy never creates Status or Priority labels", () => {
  const definitions = taxonomyLabelDefinitions(config);
  assert.equal(definitions.some((label) => /^(status|priority):/i.test(label.name)), false);
  assert(definitions.some((label) => label.name === "taxonomy-conflict"));
});

test("forbidden label audit matches configured field values, not unrelated needs labels", () => {
  for (const name of ["P0", "P3", "Inbox", "Needs info", "Done", "priority:high", "status:open", "needs-info"]) {
    assert.equal(isForbiddenWorkflowLabel(name, config), true, name);
  }
  for (const name of ["needs-docs", "bug", "type:release"]) {
    assert.equal(isForbiddenWorkflowLabel(name, config), false, name);
  }
});

test("reusable workflow binds its action checkout to the pinned called-workflow SHA", () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, "../../.github/workflows/issue-hub-sync-reusable.yml"), "utf8");
  assert.match(workflow, /repository: \$\{\{ job\.workflow_repository \}\}/);
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /foundation_sha/);
});

test("dry-run models missing fields and views without writing or throwing", async () => {
  const builtIns = [
    { id: "title", name: "Title", dataType: "TITLE" },
    { id: "repository", name: "Repository", dataType: "REPOSITORY" },
    { id: "assignees", name: "Assignees", dataType: "ASSIGNEES" },
    { id: "labels", name: "Labels", dataType: "LABELS" }
  ];
  const client = {
    async getProjectFields() { return structuredClone(builtIns); },
    async graphql(query) {
      assert.match(query, /IssueHubViews/);
      return {
        node: {
          __typename: "ProjectV2",
          views: {
            nodes: [{
              id: "default-view",
              number: 1,
              name: "View 1",
              layout: "TABLE_LAYOUT",
              filter: null,
              configuration: { visibleFields: { nodes: builtIns } }
            }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      };
    }
  };
  const reconciler = new FoundationReconciler({ client, config, apply: false });
  const project = { id: "project" };
  const shape = await reconciler.ensureFields(project);
  await reconciler.ensureViews(project, shape);
  assert.equal(reconciler.operations.filter((operation) => operation.target === "field").length, 4);
  assert.equal(reconciler.operations.filter((operation) => operation.target === "view").length, 5);
  assert.equal(reconciler.operations.filter((operation) => operation.target === "auto-default-view").length, 1);
});

test("known enabled default workflows are removed and unknown enabled workflows fail loud", async () => {
  const pages = [
    {
      nodes: [{ id: "known", number: 1, name: "Item closed", enabled: true }],
      pageInfo: { hasNextPage: true, endCursor: "page-2" }
    },
    {
      nodes: [{ id: "disabled", number: 2, name: "Custom disabled", enabled: false }],
      pageInfo: { hasNextPage: false, endCursor: null }
    }
  ];
  const client = {
    async graphql(_query, variables) {
      return { node: { __typename: "ProjectV2", workflows: variables.after ? pages[1] : pages[0] } };
    }
  };
  const reconciler = new FoundationReconciler({ client, config, apply: false });
  await reconciler.ensureNoConflictingWorkflows({ id: "project" });
  assert.deepEqual(reconciler.operations, [{
    kind: "delete",
    target: "conflicting-project-workflow",
    name: "Item closed",
    number: 1
  }]);

  const badClient = {
    async graphql() {
      return {
        node: {
          __typename: "ProjectV2",
          workflows: {
            nodes: [{ id: "custom", number: 9, name: "Custom enabled", enabled: true }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      };
    }
  };
  const bad = new FoundationReconciler({ client: badClient, config, apply: false });
  await assert.rejects(() => bad.ensureNoConflictingWorkflows({ id: "project" }), /Unexpected enabled Project workflows/);
});

test("CLI defaults to a read-only reconciliation", () => {
  assert.deepEqual(parseArgs(["node", "reconcile.js"]), {
    apply: false,
    backfill: false,
    help: false
  });
  assert.throws(() => parseArgs(["node", "reconcile.js", "--skip-labels"]), /Unknown argument/);
});
