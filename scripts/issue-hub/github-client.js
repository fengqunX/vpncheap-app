"use strict";

class GitHubApiError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.errors = errors;
  }
}

class GitHubClient {
  constructor({ token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error("GH_TOKEN/project token is required");
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "vpncheap-issue-hub-foundation"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: "GitHub returned a non-JSON response" };
      }
    }
    if (!response.ok) {
      const detail = data?.errors ? `; details: ${JSON.stringify(data.errors)}` : "";
      throw new GitHubApiError(
        `GitHub REST ${method} ${path} failed (${response.status}): ${data?.message ?? "unknown error"}${detail}`,
        { status: response.status, errors: data?.errors }
      );
    }
    return data;
  }

  async graphql(query, variables = {}) {
    const data = await this.request("/graphql", { method: "POST", body: { query, variables } });
    if (data?.errors?.length) {
      const messages = data.errors.map((error) => error.message).join("; ");
      throw new GitHubApiError(`GitHub GraphQL failed: ${messages}`, { errors: data.errors });
    }
    if (!data?.data) throw new GitHubApiError("GitHub GraphQL returned no data");
    return data.data;
  }

  async getViewer() {
    return this.request("/user");
  }

  async getIssue(issueNodeId) {
    let after = null;
    let issue = null;
    const labels = [];
    do {
      const data = await this.graphql(`
      query IssueHubLiveIssue($id: ID!, $after: String) {
        node(id: $id) {
          __typename
          ... on Issue {
            number
            state
            labels(first: 100, after: $after) {
              nodes { name }
              pageInfo { hasNextPage endCursor }
            }
            repository { name owner { login } }
          }
        }
      }
      `, { id: issueNodeId, after });
      if (!data.node) throw new Error(`Issue node is not visible: ${issueNodeId}`);
      if (data.node.__typename !== "Issue") return { type: data.node.__typename };
      issue = data.node;
      labels.push(...issue.labels.nodes.map((label) => label.name));
      after = issue.labels.pageInfo.hasNextPage ? issue.labels.pageInfo.endCursor : null;
    } while (after);

    return {
      type: "Issue",
      number: issue.number,
      state: issue.state.toLowerCase(),
      labels,
      repository: issue.repository.name,
      repositoryOwner: issue.repository.owner.login
    };
  }

  async findProject(owner, title) {
    let after = null;
    let userFound = false;
    const projects = [];
    do {
      const data = await this.graphql(`
      query IssueHubProject($login: String!, $after: String) {
        user(login: $login) {
          projectsV2(first: 100, after: $after) {
            nodes { id number title url closed viewerCanUpdate }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      `, { login: owner, after });
      if (!data.user) throw new Error(`Project owner is not a visible GitHub user: ${owner}`);
      userFound = true;
      projects.push(...data.user.projectsV2.nodes);
      after = data.user.projectsV2.pageInfo.hasNextPage
        ? data.user.projectsV2.pageInfo.endCursor
        : null;
    } while (after);
    if (!userFound) throw new Error(`Project owner is not a visible GitHub user: ${owner}`);

    const matches = projects.filter((project) => project.title === title);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one Project named ${JSON.stringify(title)} for ${owner}; found ${matches.length}`);
    }
    const project = matches[0];
    if (project.closed) throw new Error(`Project is closed: ${project.url}`);
    if (!project.viewerCanUpdate) throw new Error(`Token cannot update Project: ${project.url}`);
    project.fields = { nodes: await this.getProjectFields(project.id) };
    return project;
  }

  async getProjectFields(projectId) {
    let after = null;
    const fields = [];
    do {
      const data = await this.graphql(`
        query IssueHubProjectFields($id: ID!, $after: String) {
          node(id: $id) {
            __typename
            ... on ProjectV2 {
              fields(first: 100, after: $after) {
                nodes {
                  __typename
                  ... on ProjectV2Field { id name dataType }
                  ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `, { id: projectId, after });
      if (data.node?.__typename !== "ProjectV2") throw new Error(`Project node is not visible: ${projectId}`);
      fields.push(...data.node.fields.nodes);
      after = data.node.fields.pageInfo.hasNextPage ? data.node.fields.pageInfo.endCursor : null;
    } while (after);
    return fields;
  }

  async findIssueProjectItem(issueNodeId, projectId) {
    let after = null;
    do {
      const data = await this.graphql(`
      query IssueHubItem($id: ID!, $after: String) {
        node(id: $id) {
          __typename
          ... on Issue {
            projectItems(first: 100, after: $after) {
              nodes {
                id
                project { id }
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
      `, { id: issueNodeId, after });
      if (data.node?.__typename !== "Issue") return null;
      const item = data.node.projectItems.nodes.find((candidate) => candidate.project.id === projectId);
      if (item) return { id: item.id, status: item.fieldValueByName?.name ?? null };
      after = data.node.projectItems.pageInfo.hasNextPage
        ? data.node.projectItems.pageInfo.endCursor
        : null;
    } while (after);
    return null;
  }

  async addProjectItem(projectId, contentId) {
    const data = await this.graphql(`
      mutation IssueHubAddItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }
    `, { projectId, contentId });
    if (!data.addProjectV2ItemById?.item?.id) throw new Error("Project item mutation returned no item ID");
    return data.addProjectV2ItemById.item;
  }

  async updateProjectStatus(project, itemId, statusName) {
    const fields = project.fields.nodes.filter((field) => field.name === "Status");
    if (fields.length !== 1 || fields[0].__typename !== "ProjectV2SingleSelectField") {
      throw new Error(`Expected exactly one SINGLE_SELECT Status field; found ${fields.length}`);
    }
    const options = fields[0].options.filter((option) => option.name === statusName);
    if (options.length !== 1) {
      throw new Error(`Expected exactly one Status option ${JSON.stringify(statusName)}; found ${options.length}`);
    }
    await this.graphql(`
      mutation IssueHubSetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }
    `, {
      projectId: project.id,
      itemId,
      fieldId: fields[0].id,
      optionId: options[0].id
    });
  }

  async addIssueLabels(owner, repo, issueNumber, labels) {
    if (labels.length === 0) return;
    await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: { labels }
    });
  }

  async removeIssueLabel(owner, repo, issueNumber, label) {
    try {
      await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE"
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }
}

module.exports = { GitHubApiError, GitHubClient };
