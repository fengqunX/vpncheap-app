#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { GitHubClient } = require("./github-client");
const { loadConfig, syncIssueEvent } = require("./core");

const CONFIG_PATH = path.resolve(__dirname, "../../governance/issue-hub.json");

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const known = new Set(["--apply", "--backfill", "--help"]);
  const unknown = [...args].filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  return {
    apply: args.has("--apply"),
    backfill: args.has("--backfill"),
    help: args.has("--help")
  };
}

function usage() {
  return [
    "Usage: node scripts/issue-hub/reconcile.js [--apply] [--backfill]",
    "",
    "Default is a read-only drift report. --apply performs idempotent foundation writes.",
    "--backfill reconciles every open issue (pull requests excluded) after foundation setup.",
    "Requires process-local GH_TOKEN for the fengqunX team account; the token is never printed."
  ].join("\n");
}

function optionShape(option) {
  return { name: option.name, color: option.color, description: option.description ?? "" };
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taxonomyLabelDefinitions(config) {
  const labels = [];
  for (const category of config.taxonomy.categories) {
    const style = config.taxonomy.labelStyle[category.name];
    for (const name of category.labels) {
      labels.push({
        name,
        color: style.color,
        description: `${style.description}: ${name.split(":").slice(1).join(":")}`
      });
    }
  }
  labels.push(config.taxonomy.conflictLabel);
  return labels;
}

function forbiddenWorkflowLabelNames(config) {
  const names = new Set();
  for (const field of config.project.fields.filter((candidate) => ["Status", "Priority"].includes(candidate.name))) {
    for (const option of field.options ?? []) names.add(option.name.toLowerCase());
  }
  for (const alias of ["needs-info", "needs-information", "needs-triage", "needs-verification", "in-progress"]) {
    names.add(alias);
  }
  return names;
}

function isForbiddenWorkflowLabel(label, config) {
  const normalized = label.trim().toLowerCase();
  return /^(?:status|priority):/.test(normalized)
    || forbiddenWorkflowLabelNames(config).has(normalized);
}

class FoundationReconciler {
  constructor({ client, config, apply }) {
    this.client = client;
    this.config = config;
    this.apply = apply;
    this.operations = [];
    this.projectCreated = false;
  }

  record(kind, target, detail = {}) {
    this.operations.push({ kind, target, ...detail });
  }

  async findOwnerAndProject() {
    let after = null;
    let owner = null;
    const projects = [];
    do {
      const data = await this.client.graphql(`
        query IssueHubFoundation($login: String!, $after: String) {
          user(login: $login) {
            id login
            projectsV2(first: 100, after: $after) {
              nodes { id number title url closed public shortDescription readme viewerCanUpdate }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { login: this.config.project.owner, after });
      if (!data.user) throw new Error(`GitHub user not found: ${this.config.project.owner}`);
      owner = { id: data.user.id, login: data.user.login };
      projects.push(...data.user.projectsV2.nodes);
      after = data.user.projectsV2.pageInfo.hasNextPage
        ? data.user.projectsV2.pageInfo.endCursor
        : null;
    } while (after);

    const matches = projects.filter((project) => project.title === this.config.project.title);
    if (matches.length > 1) {
      throw new Error(`Duplicate Projects named ${JSON.stringify(this.config.project.title)}: ${matches.length}`);
    }
    return { owner, project: matches[0] ?? null };
  }

  async ensureProject() {
    const { owner, project: existing } = await this.findOwnerAndProject();
    let project = existing;
    if (!project) {
      this.record("create", "project", { title: this.config.project.title });
      if (!this.apply) return null;
      const data = await this.client.graphql(`
        mutation CreateIssueHub($ownerId: ID!, $title: String!) {
          createProjectV2(input: { ownerId: $ownerId, title: $title }) {
            projectV2 { id number title url closed public shortDescription readme viewerCanUpdate }
          }
        }
      `, { ownerId: owner.id, title: this.config.project.title });
      project = data.createProjectV2?.projectV2;
      if (!project?.id) throw new Error("createProjectV2 returned no project ID");
      this.projectCreated = true;
    }

    if (project.closed) throw new Error(`Refusing to reconcile closed Project: ${project.url}`);
    if (!project.viewerCanUpdate) throw new Error(`Token cannot update Project: ${project.url}`);
    const metadataDrift = project.shortDescription !== this.config.project.shortDescription
      || project.readme !== this.config.project.readme
      || project.public !== false;
    if (metadataDrift) {
      this.record("update", "project-metadata");
      if (this.apply) {
        await this.client.graphql(`
          mutation UpdateIssueHub($projectId: ID!, $shortDescription: String!, $readme: String!) {
            updateProjectV2(input: {
              projectId: $projectId,
              shortDescription: $shortDescription,
              readme: $readme,
              closed: false,
              public: false
            }) { projectV2 { id } }
          }
        `, {
          projectId: project.id,
          shortDescription: this.config.project.shortDescription,
          readme: this.config.project.readme
        });
      }
    }
    return project;
  }

  async getProjectShape(projectId) {
    const fields = await this.client.getProjectFields(projectId);
    const views = [];
    let after = null;
    do {
      const data = await this.client.graphql(`
        query IssueHubViews($id: ID!, $after: String) {
          node(id: $id) {
            __typename
            ... on ProjectV2 {
              views(first: 100, after: $after) {
              nodes {
                id number name layout filter
                configuration { visibleFields(first: 100) { nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } } } }
              }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `, { id: projectId, after });
      if (data.node?.__typename !== "ProjectV2") throw new Error(`Project node is not visible: ${projectId}`);
      views.push(...data.node.views.nodes);
      after = data.node.views.pageInfo.hasNextPage ? data.node.views.pageInfo.endCursor : null;
    } while (after);
    return { fields: { nodes: fields }, views: { nodes: views } };
  }

  async ensureFields(project) {
    let shape = await this.getProjectShape(project.id);
    for (const spec of this.config.project.fields) {
      const matches = shape.fields.nodes.filter((field) => field.name === spec.name);
      if (matches.length > 1) throw new Error(`Duplicate Project field ${JSON.stringify(spec.name)}: ${matches.length}`);
      const field = matches[0];
      if (!field) {
        this.record("create", "field", { name: spec.name, dataType: spec.dataType });
        if (this.apply) {
          await this.client.graphql(`
            mutation CreateIssueHubField($projectId: ID!, $dataType: ProjectV2CustomFieldType!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
              createProjectV2Field(input: { projectId: $projectId, dataType: $dataType, name: $name, singleSelectOptions: $options }) {
                projectV2Field { __typename }
              }
            }
          `, {
            projectId: project.id,
            dataType: spec.dataType,
            name: spec.name,
            options: spec.options ?? null
          });
          shape = await this.getProjectShape(project.id);
        } else {
          shape.fields.nodes.push({
            __typename: spec.dataType === "SINGLE_SELECT" ? "ProjectV2SingleSelectField" : "ProjectV2Field",
            id: `dry-run-field:${spec.name}`,
            name: spec.name,
            dataType: spec.dataType,
            options: spec.options ?? []
          });
        }
        continue;
      }

      if (field.dataType !== spec.dataType) {
        throw new Error(`Project field ${spec.name} has type ${field.dataType ?? field.__typename}; expected ${spec.dataType}`);
      }
      if (spec.dataType !== "SINGLE_SELECT") continue;

      const currentOptions = field.options.map(optionShape);
      const desiredOptions = spec.options.map(optionShape);
      if (!equalJson(currentOptions, desiredOptions)) {
        this.record("update", "field-options", { name: spec.name });
        if (this.apply) {
          const existingByName = new Map(field.options.map((option) => [option.name, option]));
          const options = spec.options.map((option) => ({
            ...(existingByName.has(option.name) ? { id: existingByName.get(option.name).id } : {}),
            ...option
          }));
          await this.client.graphql(`
            mutation UpdateIssueHubField($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
              updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
                projectV2Field { __typename }
              }
            }
          `, { fieldId: field.id, options });
          shape = await this.getProjectShape(project.id);
        }
      }
    }

    if (this.apply) shape = await this.getProjectShape(project.id);
    for (const required of ["Repository", "Assignees"]) {
      const count = shape.fields.nodes.filter((field) => field.name === required).length;
      if (count !== 1) throw new Error(`Expected one built-in ${required} field; found ${count}`);
    }
    return shape;
  }

  async ensureViews(project, shape) {
    const fieldByName = new Map(shape.fields.nodes.map((field) => [field.name, field]));
    for (const spec of this.config.project.views) {
      const visibleFieldIds = spec.visibleFields.map((name) => {
        const field = fieldByName.get(name);
        if (!field) throw new Error(`View ${spec.name} references missing field: ${name}`);
        return field.id;
      });
      let matches = shape.views.nodes.filter((view) => view.name === spec.name);
      if (matches.length > 1) throw new Error(`Duplicate Project view ${JSON.stringify(spec.name)}: ${matches.length}`);
      let view = matches[0];

      if (!view && this.projectCreated && spec.name === "CEO 看板" && shape.views.nodes.length === 1) {
        view = shape.views.nodes[0];
      }
      if (!view) {
        this.record("create", "view", { name: spec.name, layout: spec.layout, filter: spec.filter });
        if (!this.apply) {
          view = {
            id: `dry-run-view:${spec.name}`,
            number: null,
            name: spec.name,
            layout: spec.layout,
            filter: spec.filter,
            configuration: { visibleFields: { nodes: visibleFieldIds.map((id) => ({ id })) } }
          };
          shape.views.nodes.push(view);
        } else {
          const data = await this.client.graphql(`
          mutation CreateIssueHubView($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $visibleFieldIds: [ID!]!) {
            createProjectV2View(input: {
              projectId: $projectId,
              name: $name,
              layout: $layout,
              configuration: { visibleFieldIds: $visibleFieldIds }
            }) { projectV2View { id name layout filter } }
          }
          `, { projectId: project.id, name: spec.name, layout: spec.layout, visibleFieldIds });
          view = data.createProjectV2View?.projectV2View;
          if (!view?.id) throw new Error(`createProjectV2View returned no ID for ${spec.name}`);
        }
      }

      const currentVisibleIds = view.configuration?.visibleFields?.nodes?.map((field) => field.id) ?? [];
      const drift = view.name !== spec.name
        || view.layout !== spec.layout
        || (view.filter ?? "") !== spec.filter
        || !equalJson(currentVisibleIds, visibleFieldIds);
      if (drift) {
        this.record("update", "view", { name: spec.name, layout: spec.layout, filter: spec.filter });
        if (this.apply) {
          await this.client.graphql(`
            mutation UpdateIssueHubView($viewId: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $filter: String!, $visibleFieldIds: [ID!]!) {
              updateProjectV2View(input: {
                viewId: $viewId,
                name: $name,
                layout: $layout,
                filter: $filter,
                configuration: { visibleFieldIds: $visibleFieldIds }
              }) { projectV2View { id } }
            }
          `, { viewId: view.id, name: spec.name, layout: spec.layout, filter: spec.filter, visibleFieldIds });
        }
      }

      if (this.apply) shape = await this.getProjectShape(project.id);
    }

    if (this.apply) shape = await this.getProjectShape(project.id);
    if (this.config.project.removeAutoDefaultView) {
      const desiredNames = new Set(this.config.project.views.map((view) => view.name));
      const desiredComplete = [...desiredNames].every((name) => shape.views.nodes.some((view) => view.name === name));
      const candidates = shape.views.nodes.filter((view) => !desiredNames.has(view.name));
      for (const view of candidates) {
        const isUntouchedAutoDefault = view.number === 1
          && view.name === "View 1"
          && view.layout === "TABLE_LAYOUT"
          && (view.filter ?? "") === "";
        if (!isUntouchedAutoDefault) continue;
        if (!desiredComplete) throw new Error("Refusing to remove auto-default view before all governed views exist");
        this.record("delete", "auto-default-view", { name: view.name, number: view.number });
        if (this.apply) {
          await this.client.graphql(`
            mutation DeleteIssueHubDefaultView($viewId: ID!) {
              deleteProjectV2View(input: { viewId: $viewId }) { projectV2View { id } }
            }
          `, { viewId: view.id });
        }
      }
    }
  }

  async listProjectWorkflows(projectId) {
    const workflows = [];
    let after = null;
    do {
      const data = await this.client.graphql(`
        query IssueHubWorkflows($id: ID!, $after: String) {
          node(id: $id) {
            __typename
            ... on ProjectV2 {
              workflows(first: 100, after: $after) {
                nodes { id number name enabled }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `, { id: projectId, after });
      if (data.node?.__typename !== "ProjectV2") throw new Error(`Project node is not visible: ${projectId}`);
      workflows.push(...data.node.workflows.nodes);
      after = data.node.workflows.pageInfo.hasNextPage
        ? data.node.workflows.pageInfo.endCursor
        : null;
    } while (after);
    return workflows;
  }

  async ensureNoConflictingWorkflows(project) {
    const removable = new Set(this.config.project.removeEnabledDefaultWorkflows ?? []);
    const workflows = await this.listProjectWorkflows(project.id);
    const unexpected = workflows.filter((workflow) => workflow.enabled && !removable.has(workflow.name));
    if (unexpected.length > 0) {
      throw new Error(`Unexpected enabled Project workflows: ${unexpected.map((workflow) => workflow.name).join(", ")}`);
    }
    for (const workflow of workflows.filter((candidate) => candidate.enabled)) {
      this.record("delete", "conflicting-project-workflow", { name: workflow.name, number: workflow.number });
      if (this.apply) {
        await this.client.graphql(`
          mutation DeleteIssueHubWorkflow($workflowId: ID!) {
            deleteProjectV2Workflow(input: { workflowId: $workflowId }) { deletedWorkflowId }
          }
        `, { workflowId: workflow.id });
      }
    }
  }

  async listRepositoryLabels(repo) {
    const labels = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.client.request(`/repos/${this.config.project.owner}/${repo}/labels?per_page=100&page=${page}`);
      labels.push(...batch);
      if (batch.length < 100) break;
    }
    return labels;
  }

  async auditForbiddenLabels() {
    const forbidden = [];
    for (const repo of Object.keys(this.config.taxonomy.repositories)) {
      const labels = await this.listRepositoryLabels(repo);
      for (const label of labels) {
        if (isForbiddenWorkflowLabel(label.name, this.config)) {
          forbidden.push(`${repo}:${label.name}`);
        }
      }
    }
    if (forbidden.length > 0) {
      throw new Error(`Forbidden duplicate Status/Priority labels exist: ${forbidden.join(", ")}`);
    }
  }

  async ensureLabels() {
    const definitions = taxonomyLabelDefinitions(this.config);
    for (const repo of Object.keys(this.config.taxonomy.repositories)) {
      const current = await this.listRepositoryLabels(repo);
      const byName = new Map(current.map((label) => [label.name.toLowerCase(), label]));
      for (const spec of definitions) {
        const label = byName.get(spec.name.toLowerCase());
        if (!label) {
          this.record("create", "label", { repository: repo, name: spec.name });
          if (this.apply) {
            await this.client.request(`/repos/${this.config.project.owner}/${repo}/labels`, {
              method: "POST",
              body: spec
            });
          }
          continue;
        }
        if (label.name !== spec.name || label.color.toUpperCase() !== spec.color.toUpperCase() || (label.description ?? "") !== spec.description) {
          this.record("update", "label", { repository: repo, name: spec.name });
          if (this.apply) {
            await this.client.request(`/repos/${this.config.project.owner}/${repo}/labels/${encodeURIComponent(label.name)}`, {
              method: "PATCH",
              body: { new_name: spec.name, color: spec.color, description: spec.description }
            });
          }
        }
      }
    }
  }

  async listOpenIssues(repo) {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.client.request(`/repos/${this.config.project.owner}/${repo}/issues?state=open&per_page=100&page=${page}`);
      issues.push(...batch.filter((issue) => !issue.pull_request));
      if (batch.length < 100) break;
    }
    return issues;
  }

  async backfill(project) {
    let count = 0;
    for (const repo of Object.keys(this.config.taxonomy.repositories)) {
      const issues = await this.listOpenIssues(repo);
      for (const issue of issues) {
        count += 1;
        if (!this.apply) {
          this.record("would-reconcile", "open-issue", { repository: repo, number: issue.number });
          continue;
        }
        const result = await syncIssueEvent({
          eventName: "issues",
          payload: {
            action: "opened",
            issue: { node_id: issue.node_id, number: issue.number, state: issue.state, labels: issue.labels },
            repository: { name: repo, owner: { login: this.config.project.owner } }
          },
          config: this.config,
          client: this.client
        });
        if (result.itemAdded || result.statusChanged || result.labelsAdded.length > 0 || result.labelsRemoved.length > 0) {
          this.record("reconcile", "open-issue", { repository: repo, number: issue.number });
        }
      }
    }
    return count;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const config = loadConfig(CONFIG_PATH);
  const client = new GitHubClient({ token: process.env.GH_TOKEN });
  const viewer = await client.getViewer();
  if (viewer.login !== config.project.owner) {
    throw new Error(`Authenticated GitHub user is ${viewer.login}; expected ${config.project.owner}`);
  }

  const reconciler = new FoundationReconciler({ client, config, apply: args.apply });
  await reconciler.auditForbiddenLabels();
  const project = await reconciler.ensureProject();
  if (project) {
    const shape = await reconciler.ensureFields(project);
    await reconciler.ensureViews(project, shape);
    await reconciler.ensureNoConflictingWorkflows(project);
  } else {
    for (const field of config.project.fields) reconciler.record("create", "field", { name: field.name, dataType: field.dataType });
    for (const view of config.project.views) reconciler.record("create", "view", { name: view.name, layout: view.layout, filter: view.filter });
  }
  await reconciler.ensureLabels();
  const backfillCount = args.backfill ? await reconciler.backfill(project) : 0;

  console.log(JSON.stringify({
    mode: args.apply ? "apply" : "dry-run",
    authenticatedUser: viewer.login,
    project: project ? { id: project.id, number: project.number, url: project.url } : null,
    backfillCount,
    operationCount: reconciler.operations.length,
    operations: reconciler.operations
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Issue hub reconciliation failed: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  FoundationReconciler,
  forbiddenWorkflowLabelNames,
  isForbiddenWorkflowLabel,
  parseArgs,
  taxonomyLabelDefinitions
};
