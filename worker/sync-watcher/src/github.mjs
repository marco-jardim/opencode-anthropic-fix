/**
 * GitHub API client for PR and issue creation.
 *
 * Provides typed wrappers around the GitHub REST API v3 with:
 * - Auth via Bearer token
 * - Rate limit detection and backoff
 * - Idempotent PR/issue search before create
 *
 * @module github
 */

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 15_000;
const SERVER_ERROR_MAX_RETRIES = 1;
const SERVER_ERROR_RETRY_DELAY_MS = 2_000;

/**
 * @typedef {Object} GitHubClient
 * @property {function} createOrUpdatePR
 * @property {function} createOrUpdateIssue
 */

/**
 * Make an authenticated GitHub API request.
 *
 * @param {string} token - GitHub personal access token
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. "/repos/owner/repo/pulls")
 * @param {object|null} [body] - Request body
 * @returns {Promise<{status: number, data: any}>}
 * @throws {Error} on auth failure, rate limit, or server error
 */
export async function githubRequest(token, method, path, body = null) {
  const url = `${GITHUB_API}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "opencode-sync-watcher/1.0",
  };

  let lastServerError;
  for (let attempt = 0; attempt <= SERVER_ERROR_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, SERVER_ERROR_RETRY_DELAY_MS));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`GitHub API request timed out: ${method} ${path}`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Rate limit
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      if (remaining === "0") {
        const resetTs = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "unknown";
        throw new Error(`GitHub API rate limit exceeded, resets at ${resetTs}`);
      }
      // Auth failure (403 without rate limit)
      const errBody = await response.json().catch(() => ({}));
      throw new Error(`GitHub API auth/permission error (${response.status}): ${errBody.message ?? "unknown"}`);
    }

    // Server errors — retry once
    if (response.status >= 500) {
      lastServerError = new Error(`GitHub API server error ${response.status}: ${method} ${path}`);
      continue;
    }

    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  }

  throw lastServerError;
}

/**
 * Search for an existing open PR with a specific head branch.
 *
 * @param {string} token
 * @param {string} repo - "owner/name"
 * @param {string} headBranch - Branch name e.g. "auto/sync-2.1.91"
 * @returns {Promise<{number: number, html_url: string}|null>}
 */
export async function findExistingPR(token, repo, headBranch) {
  const [owner, repoName] = repo.split("/");
  const path = `/repos/${owner}/${repoName}/pulls?state=open&head=${encodeURIComponent(owner + ":" + headBranch)}&per_page=1`;
  const { data } = await githubRequest(token, "GET", path);
  if (Array.isArray(data) && data.length > 0) {
    return { number: data[0].number, html_url: data[0].html_url };
  }
  return null;
}

/**
 * Search for an existing open issue with a title containing a search string.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} titleSearch - Substring to search for in issue titles
 * @returns {Promise<{number: number, html_url: string}|null>}
 */
export async function findExistingIssue(token, repo, titleSearch) {
  const [_owner, _repoName] = repo.split("/");
  const q = encodeURIComponent(`repo:${repo} is:issue is:open "${titleSearch}" in:title`);
  const path = `/search/issues?q=${q}&per_page=1`;
  const { data } = await githubRequest(token, "GET", path);
  if (data?.items?.length > 0) {
    const item = data.items[0];
    return { number: item.number, html_url: item.html_url };
  }
  return null;
}

/**
 * Create a branch ref in the repository.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} branchName
 * @param {string} baseSha - SHA of the commit to branch from (typically HEAD of main)
 * @returns {Promise<void>}
 */
export async function createBranch(token, repo, branchName, baseSha) {
  const [owner, repoName] = repo.split("/");
  await githubRequest(token, "POST", `/repos/${owner}/${repoName}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });
}

/**
 * Get the SHA of the latest commit on a branch.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} branch - Branch name (e.g. "master")
 * @returns {Promise<string>} commit SHA
 */
export async function getBranchSha(token, repo, branch) {
  const [owner, repoName] = repo.split("/");
  const { data } = await githubRequest(
    token,
    "GET",
    `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  return data.object.sha;
}

/**
 * Get the content and SHA of a file in the repository.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} filePath
 * @param {string} branch
 * @returns {Promise<{content: string, sha: string}>}
 */
export async function getFileContent(token, repo, filePath, branch) {
  const [owner, repoName] = repo.split("/");
  const { data } = await githubRequest(
    token,
    "GET",
    `/repos/${owner}/${repoName}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
  );
  // Content is base64-encoded UTF-8. Decode via Uint8Array → TextDecoder
  // to correctly handle multi-byte characters (avoids deprecated escape/unescape).
  const binaryStr = atob(data.content.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
  const content = new TextDecoder().decode(bytes);
  return { content, sha: data.sha };
}

/**
 * Update a file in the repository.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} filePath
 * @param {string} branch
 * @param {string} content - New file content (plain text)
 * @param {string} fileSha - Current file SHA (required by GitHub API)
 * @param {string} commitMessage
 * @returns {Promise<void>}
 */
export async function updateFile(token, repo, filePath, branch, content, fileSha, commitMessage) {
  const [owner, repoName] = repo.split("/");
  // Encode UTF-8 text → base64 via TextEncoder → Uint8Array → btoa
  // Do NOT spread large Uint8Arrays into String.fromCharCode — stack overflow for files > ~64KB.
  // Instead, process in 8KB chunks.
  const encBytes = new TextEncoder().encode(content);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < encBytes.length; i += CHUNK) {
    binary += String.fromCharCode(...encBytes.subarray(i, i + CHUNK));
  }
  const encodedContent = btoa(binary);
  await githubRequest(token, "PUT", `/repos/${owner}/${repoName}/contents/${filePath}`, {
    message: commitMessage,
    content: encodedContent,
    sha: fileSha,
    branch,
  });
}

/**
 * Create a pull request.
 *
 * @param {string} token
 * @param {string} repo
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.head - Head branch
 * @param {string} opts.base - Base branch (e.g. "master")
 * @param {string[]} [opts.assignees] - GitHub usernames to assign
 * @returns {Promise<{number: number, html_url: string}>}
 */
export async function createPR(token, repo, { title, body, head, base, assignees }) {
  const [owner, repoName] = repo.split("/");
  const { data } = await githubRequest(token, "POST", `/repos/${owner}/${repoName}/pulls`, {
    title,
    body,
    head,
    base,
  });
  // GitHub's PR creation endpoint does not support assignees — add via issues API
  // (PRs are issues in GitHub's data model, so the issues assignees endpoint works)
  if (assignees?.length) {
    await githubRequest(token, "POST", `/repos/${owner}/${repoName}/issues/${data.number}/assignees`, { assignees });
  }
  return { number: data.number, html_url: data.html_url };
}

/**
 * Update an existing pull request body.
 *
 * @param {string} token
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function updatePRBody(token, repo, prNumber, body) {
  const [owner, repoName] = repo.split("/");
  await githubRequest(token, "PATCH", `/repos/${owner}/${repoName}/pulls/${prNumber}`, { body });
}

/**
 * Create an issue.
 *
 * @param {string} token
 * @param {string} repo
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string[]} opts.labels
 * @param {string[]} [opts.assignees] - GitHub usernames to assign
 * @returns {Promise<{number: number, html_url: string}>}
 */
export async function createIssue(token, repo, { title, body, labels, assignees }) {
  const [owner, repoName] = repo.split("/");
  const payload = { title, body, labels };
  if (assignees?.length) payload.assignees = assignees;
  const { data } = await githubRequest(token, "POST", `/repos/${owner}/${repoName}/issues`, payload);
  return { number: data.number, html_url: data.html_url };
}

/**
 * Update an existing issue body (append note).
 *
 * @param {string} token
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function updateIssueBody(token, repo, issueNumber, body) {
  const [owner, repoName] = repo.split("/");
  await githubRequest(token, "PATCH", `/repos/${owner}/${repoName}/issues/${issueNumber}`, { body });
}
