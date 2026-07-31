"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_ACTIONS = new Set([
  "opened",
  "reopened",
  "transferred",
  "closed",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned"
]);

const TAXONOMY_ACTIONS = new Set([
  "opened",
  "reopened",
  "transferred",
  "labeled",
  "unlabeled"
]);

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (config?.schemaVersion !== 1) {
    throw new Error(`Unsupported governance schemaVersion: ${config?.schemaVersion ?? "missing"}`);
  }
  if (!config?.project?.owner || !config?.project?.title) {
    throw new Error("Project owner and title are required");
  }

  const fieldNames = config.project.fields.map((field) => field.name);
  assertUnique(fieldNames, "project field names");
  assertUnique(config.project.views.map((view) => view.name), "project view names");
  assertUnique(config.project.removeEnabledDefaultWorkflows ?? [], "removable Project workflow names");
  for (const required of ["Status", "Priority", "Customer reports count", "Last report date"]) {
    if (!fieldNames.includes(required)) {
      throw new Error(`Missing required Project field: ${required}`);
    }
  }

  const status = config.project.fields.find((field) => field.name === "Status");
  const statusNames = status.options?.map((option) => option.name) ?? [];
  assertUnique(statusNames, "Status option names");
  for (const required of ["Inbox", "Needs info", "Triaged", "Planned", "In progress", "Verify", "Done"]) {
    if (!statusNames.includes(required)) {
      throw new Error(`Missing required Status option: ${required}`);
    }
  }

  const taxonomyLabels = config.taxonomy.categories.flatMap((category) => category.labels);
  assertUnique(taxonomyLabels, "taxonomy labels");
  if (taxonomyLabels.includes(config.taxonomy.conflictLabel.name)) {
    throw new Error("taxonomy-conflict must be a control label, not a category value");
  }

  for (const [repo, mapping] of Object.entries(config.taxonomy.repositories)) {
    for (const label of mapping.defaults) {
      if (!taxonomyLabels.includes(label)) {
        throw new Error(`Repository ${repo} has unknown default taxonomy label: ${label}`);
      }
    }
  }
}

function assertUnique(values, description) {
  const duplicates = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${description}: ${duplicates.join(", ")}`);
  }
}

function normalizeLabels(labels) {
  return [...new Set((labels ?? []).map((label) => {
    if (typeof label === "string") return label;
    return label?.name;
  }).filter(Boolean))];
}

function analyzeTaxonomy(labels, taxonomy) {
  const names = new Set(normalizeLabels(labels).map((name) => name.toLowerCase()));
  const categories = taxonomy.categories.map((category) => {
    const matched = category.labels.filter((label) => names.has(label.toLowerCase()));
    const conflict = category.cardinality === "one" && matched.length > 1;
    return { name: category.name, cardinality: category.cardinality, matched, conflict };
  });
  return {
    categories,
    hasConflict: categories.some((category) => category.conflict),
    conflicts: categories.filter((category) => category.conflict).map((category) => category.name)
  };
}

function desiredStatus({ issueState, hasTaxonomyConflict, itemAdded, currentStatus }) {
  if (issueState === "closed") return "Done";
  if (hasTaxonomyConflict) return "Needs info";
  if (itemAdded || !currentStatus) return "Inbox";
  if (currentStatus === "Done") return "Inbox";
  return null;
}

function parseIssueEvent(payload, eventName = "issues") {
  if (eventName !== "issues") {
    return { ignored: true, reason: `Unsupported event: ${eventName}` };
  }
  if (!SUPPORTED_ACTIONS.has(payload?.action)) {
    return { ignored: true, reason: `Unsupported issues action: ${payload?.action ?? "missing"}` };
  }
  if (payload?.pull_request || payload?.issue?.pull_request) {
    return { ignored: true, reason: "Pull requests are excluded" };
  }
  if (!payload?.issue?.node_id || !payload?.issue?.number || !payload?.repository?.name || !payload?.repository?.owner?.login) {
    throw new Error("Issue event is missing issue node_id/number or repository identity");
  }
  return {
    ignored: false,
    action: payload.action,
    issueNodeId: payload.issue.node_id,
    issueNumber: payload.issue.number,
    issueState: payload.issue.state,
    repository: payload.repository.name,
    repositoryOwner: payload.repository.owner.login,
    labels: normalizeLabels(payload.issue.labels)
  };
}

function effectiveTaxonomy(event, config) {
  const mapping = config.taxonomy.repositories[event.repository];
  if (!mapping) {
    throw new Error(`Repository is not governed by issue hub config: ${event.repositoryOwner}/${event.repository}`);
  }
  const shouldSync = event.issueState === "open" || TAXONOMY_ACTIONS.has(event.action);
  const defaults = shouldSync ? mapping.defaults : [];
  const labels = normalizeLabels([...event.labels, ...defaults]);
  const currentLabels = new Set(event.labels.map((label) => label.toLowerCase()));
  const analysis = analyzeTaxonomy(labels, config.taxonomy);
  return {
    shouldSync,
    defaults,
    labels,
    missingDefaults: defaults.filter((label) => !currentLabels.has(label.toLowerCase())),
    ...analysis
  };
}

async function syncIssueEvent({ payload, eventName = "issues", config, client }) {
  const eventEnvelope = parseIssueEvent(payload, eventName);
  if (eventEnvelope.ignored) return eventEnvelope;
  const liveIssue = await client.getIssue(eventEnvelope.issueNodeId);
  if (liveIssue.type !== "Issue") {
    return { ignored: true, reason: `Project content is ${liveIssue.type}, not Issue` };
  }
  const event = {
    ...eventEnvelope,
    issueNumber: liveIssue.number,
    issueState: liveIssue.state,
    repository: liveIssue.repository,
    repositoryOwner: liveIssue.repositoryOwner,
    labels: normalizeLabels(liveIssue.labels)
  };
  if (event.repositoryOwner !== config.project.owner) {
    throw new Error(`Unexpected repository owner: ${event.repositoryOwner}; expected ${config.project.owner}`);
  }

  const taxonomy = effectiveTaxonomy(event, config);
  const conflictLabel = config.taxonomy.conflictLabel.name;
  const hasConflictLabel = event.labels.some((label) => label.toLowerCase() === conflictLabel.toLowerCase());

  if (taxonomy.shouldSync) {
    if (taxonomy.missingDefaults.length > 0) {
      await client.addIssueLabels(event.repositoryOwner, event.repository, event.issueNumber, taxonomy.missingDefaults);
    }
    if (taxonomy.hasConflict && !hasConflictLabel) {
      await client.addIssueLabels(event.repositoryOwner, event.repository, event.issueNumber, [conflictLabel]);
    } else if (!taxonomy.hasConflict && hasConflictLabel) {
      await client.removeIssueLabel(event.repositoryOwner, event.repository, event.issueNumber, conflictLabel);
    }
  }

  const project = await client.findProject(config.project.owner, config.project.title);
  let item = await client.findIssueProjectItem(event.issueNodeId, project.id);
  let itemAdded = false;
  if (!item) {
    item = await client.addProjectItem(project.id, event.issueNodeId);
    itemAdded = true;
  }

  const status = desiredStatus({
    action: event.action,
    issueState: event.issueState,
    hasTaxonomyConflict: taxonomy.hasConflict,
    itemAdded,
    currentStatus: item.status
  });
  const statusChanged = Boolean(status && item.status !== status);
  if (statusChanged) {
    await client.updateProjectStatus(project, item.id, status);
  }

  return {
    ignored: false,
    repository: `${event.repositoryOwner}/${event.repository}`,
    issueNumber: event.issueNumber,
    projectId: project.id,
    itemId: item.id,
    itemAdded,
    status,
    statusChanged,
    taxonomyConflict: taxonomy.hasConflict,
    taxonomyConflicts: taxonomy.conflicts,
    labelsAdded: taxonomy.shouldSync
      ? [...taxonomy.missingDefaults, ...(taxonomy.hasConflict && !hasConflictLabel ? [conflictLabel] : [])]
      : [],
    labelsRemoved: taxonomy.shouldSync && !taxonomy.hasConflict && hasConflictLabel ? [conflictLabel] : []
  };
}

module.exports = {
  SUPPORTED_ACTIONS,
  TAXONOMY_ACTIONS,
  analyzeTaxonomy,
  desiredStatus,
  effectiveTaxonomy,
  loadConfig,
  normalizeLabels,
  parseIssueEvent,
  syncIssueEvent,
  validateConfig
};
