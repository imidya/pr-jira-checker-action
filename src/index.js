const core = require("@actions/core");
const github = require("@actions/github");
const fetch = require("node-fetch");

async function getJiraIssueInfo(issueKey, baseUrl, email, apiToken) {
  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString(
        "base64"
      )}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    console.warn(`Unable to fetch info for ${issueKey}`);
    return null;
  }

  const data = await response.json();
  const result = {
    key: issueKey,
    type: data.fields.issuetype.name,
    title: data.fields.summary,
  };

  if (
    data.fields.parent &&
    data.fields.parent.fields.issuetype.name === "Story"
  ) {
    result.parent = {
      key: data.fields.parent.key,
      type: "Story",
      title: data.fields.parent.fields.summary,
    };
  }

  return result;
}

async function getStoryChildren(storyKey, baseUrl, email, apiToken) {
  const response = await fetch(
    `${baseUrl}/rest/api/3/search?jql=parent=${storyKey}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString(
          "base64"
        )}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    console.warn(`Unable to fetch children for ${storyKey}`);
    return [];
  }

  const data = await response.json();
  return data.issues.map((issue) => ({
    key: issue.key,
    type: issue.fields.issuetype.name,
    title: issue.fields.summary,
  }));
}

async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const jiraBaseUrl = core.getInput("jira-base-url", { required: true });
    const jiraEmail = core.getInput("jira-email", { required: true });
    const jiraApiToken = core.getInput("jira-api-token", { required: true });
    const jiraTicketPattern =
      core.getInput("jira-ticket-id-pattern") || "RC-[^ ]*";

    const octokit = github.getOctokit(token);
    const context = github.context;

    // Check if this is a pull request event
    if (!context.payload.pull_request) {
      core.setFailed("This action can only be run on pull request events");
      return;
    }

    // Get PR number
    const prNumber = context.payload.pull_request.number;
    if (!prNumber) {
      core.setFailed("Could not get pull request number from context");
      return;
    }

    // Get PR commits
    const { data: commits } = await octokit.rest.pulls.listCommits({
      ...context.repo,
      pull_number: prNumber,
    });

    // Extract Jira ticket IDs from commit messages using the configured pattern
    const ticketIds = [
      ...new Set(
        commits
          .map((commit) => {
            const regex = new RegExp(jiraTicketPattern, "g");
            const matches = commit.commit.message.match(regex);
            return matches ? matches : [];
          })
          .flat()
      ),
    ];

    if (ticketIds.length === 0) {
      core.notice("No Jira ticket IDs found in commit messages");
      return;
    }

    // Get Jira issue information
    const jiraIssuesInfo = await Promise.all(
      ticketIds.map((pattern) =>
        getJiraIssueInfo(pattern, jiraBaseUrl, jiraEmail, jiraApiToken)
      )
    );

    // Generate structured output
    let output = await generateStructuredOutput(
      jiraIssuesInfo.filter(Boolean),
      ticketIds,
      jiraBaseUrl,
      jiraEmail,
      jiraApiToken
    );

    // Update PR description
    await octokit.rest.pulls.update({
      ...context.repo,
      pull_number: prNumber,
      body: output,
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function generateStructuredOutput(
  jiraIssuesInfo,
  ticketIds,
  baseUrl,
  email,
  apiToken
) {
  const getJiraLink = (issueKey) =>
    `[${issueKey}](${baseUrl}/browse/${issueKey})`;

  const storyMap = new Map();
  const orphanIssues = [];

  jiraIssuesInfo.forEach((issue) => {
    if (issue.parent) {
      const parentKey = issue.parent.key;
      if (!storyMap.has(parentKey)) {
        storyMap.set(parentKey, {
          story: issue.parent,
          children: [],
        });
      }
      storyMap.get(parentKey).children.push(issue);
    } else {
      orphanIssues.push(issue);
    }
  });

  const committedIssueKeys = new Set(ticketIds);
  const missingChildIssues = [];

  // Check each Story's children
  await Promise.all(
    [...storyMap.keys()].map(async (storyKey) => {
      const children = await getStoryChildren(
        storyKey,
        baseUrl,
        email,
        apiToken
      );
      const missingChildren = children.filter(
        (child) => !committedIssueKeys.has(child.key)
      );
      missingChildIssues.push(...missingChildren);
    })
  );

  let output = "### Related Jira Issues\n\n";

  for (const [_, data] of storyMap) {
    output += `#### Story ${getJiraLink(data.story.key)}: ${
      data.story.title
    }\n`;
    data.children.forEach((child) => {
      output += `- ${getJiraLink(child.key)}: [${child.type}] ${child.title}\n`;
    });
    output += "\n";
  }

  if (orphanIssues.length > 0) {
    output += "#### Other Issues\n";
    orphanIssues.forEach((issue) => {
      output += `- ${getJiraLink(issue.key)}: [${issue.type}] ${issue.title}\n`;
    });
    output += "\n";
  }

  if (missingChildIssues.length > 0) {
    output += "#### Missing Child Issues\n";
    output +=
      "The following child issues from related Stories are not included in this PR:\n\n";
    missingChildIssues.forEach((issue) => {
      output += `- ${getJiraLink(issue.key)}: [${issue.type}] ${issue.title}\n`;
    });
  }

  return output;
}

run();
