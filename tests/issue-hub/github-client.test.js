"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { GitHubClient } = require("../../scripts/issue-hub/github-client");

function clientFor(handler) {
  return new GitHubClient({
    token: "test-token",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const data = await handler(request.query, request.variables);
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
}

test("live issue labels paginate before taxonomy evaluation", async () => {
  const afterValues = [];
  const client = clientFor((_query, variables) => {
    afterValues.push(variables.after);
    const second = variables.after === "labels-1";
    return {
      node: {
        __typename: "Issue",
        number: 7,
        state: "OPEN",
        repository: { name: "vpncheap", owner: { login: "fengqunX" } },
        labels: {
          nodes: [{ name: second ? "runtime:flutter" : "platform:android" }],
          pageInfo: { hasNextPage: !second, endCursor: second ? null : "labels-1" }
        }
      }
    };
  });
  const issue = await client.getIssue("I_7");
  assert.deepEqual(afterValues, [null, "labels-1"]);
  assert.deepEqual(issue.labels, ["platform:android", "runtime:flutter"]);
});

test("Project discovery and fields paginate before exact matching", async () => {
  const calls = [];
  const client = clientFor((query, variables) => {
    if (query.includes("IssueHubProjectFields")) {
      calls.push(`fields:${variables.after}`);
      const second = variables.after === "fields-1";
      return {
        node: {
          __typename: "ProjectV2",
          fields: {
            nodes: [second
              ? { __typename: "ProjectV2SingleSelectField", id: "status", name: "Status", dataType: "SINGLE_SELECT", options: [] }
              : { __typename: "ProjectV2Field", id: "title", name: "Title", dataType: "TITLE" }],
            pageInfo: { hasNextPage: !second, endCursor: second ? null : "fields-1" }
          }
        }
      };
    }
    calls.push(`projects:${variables.after}`);
    const second = variables.after === "projects-1";
    return {
      user: {
        projectsV2: {
          nodes: [second
            ? { id: "target", number: 1, title: "VPNCheap 产品问题中心", url: "https://example.test", closed: false, viewerCanUpdate: true }
            : { id: "other", number: 2, title: "Other", url: "https://example.test/2", closed: false, viewerCanUpdate: true }],
          pageInfo: { hasNextPage: !second, endCursor: second ? null : "projects-1" }
        }
      }
    };
  });
  const project = await client.findProject("fengqunX", "VPNCheap 产品问题中心");
  assert.equal(project.id, "target");
  assert.deepEqual(project.fields.nodes.map((field) => field.name), ["Title", "Status"]);
  assert.deepEqual(calls, ["projects:null", "projects:projects-1", "fields:null", "fields:fields-1"]);
});

test("issue Project-item lookup paginates before deciding to add", async () => {
  const afterValues = [];
  const client = clientFor((_query, variables) => {
    afterValues.push(variables.after);
    const second = variables.after === "items-1";
    return {
      node: {
        __typename: "Issue",
        projectItems: {
          nodes: [{
            id: second ? "item-target" : "item-other",
            project: { id: second ? "project-target" : "project-other" },
            fieldValueByName: { name: second ? "Inbox" : "Done" }
          }],
          pageInfo: { hasNextPage: !second, endCursor: second ? null : "items-1" }
        }
      }
    };
  });
  const item = await client.findIssueProjectItem("I_7", "project-target");
  assert.deepEqual(afterValues, [null, "items-1"]);
  assert.deepEqual(item, { id: "item-target", status: "Inbox" });
});
