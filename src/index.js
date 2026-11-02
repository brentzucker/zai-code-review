const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 600_000;

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  const basename = filename.split('/').pop();
  return regex.test(filename) || regex.test(basename);
}

function filterFiles(files, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) {
    return files;
  }
  return files.filter(f => !excludePatterns.some(p => matchesPattern(f.filename, p)));
}

async function getChangedFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return files;
}

function buildPrompt(files, maxDiffChars, reviewHistory = '', headSha = 'unknown') {
  const patchableFiles = files.filter(f => f.patch);
  const includedDiffs = [];
  const skippedFiles = [];
  let totalChars = 0;

  for (const f of patchableFiles) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (maxDiffChars > 0 && totalChars + entry.length > maxDiffChars) {
      skippedFiles.push(f.filename);
    } else {
      includedDiffs.push(entry);
      totalChars += entry.length;
    }
  }

  let diffs = includedDiffs.join('\n\n');

  if (skippedFiles.length > 0) {
    diffs += `\n\n> **Note:** The following files were excluded because the diff exceeded the \`MAX_DIFF_CHARS\` limit:\n${skippedFiles.map(f => `> - ${f}`).join('\n')}`;
  }

  const history = reviewHistory
    ? `\n\nPrevious review rounds (context only; verify every claim against the current diff):\n${reviewHistory}\n\nFor each prior finding, state whether the current diff resolves it, leaves it unresolved, or does not provide enough evidence to decide. Cite the current changed code as evidence. Do not claim a finding is fixed merely because the code changed. Then report any new findings. Keep prior findings in their original context; this round is a follow-up, not a replacement for review history.`
    : '';

  return `Review the current pull request diff at head ${headSha}. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments. Base every finding and fix verification on evidence in the current diff, and include file/line references when available.${history}\n\nCurrent diff:\n${diffs}`;
}

async function getReviewComments(octokit, owner, repo, pullNumber) {
  const comments = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
      page,
    });
    comments.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return comments
    .filter(comment => comment.body?.includes(COMMENT_MARKER))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function getReviewHistory(comments) {
  return comments
    .filter(comment => comment.body?.includes(COMMENT_MARKER))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(comment => comment.body
    .replace(COMMENT_MARKER, '')
    .trim()).filter(Boolean).join('\n\n---\n\n');
}

async function getCurrentHeadSha(octokit, owner, repo, pullNumber) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return data.head.sha;
}

function callZaiApi(apiKey, model, systemPrompt, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error('Z.ai API response exceeded size limit.'));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error('Z.ai API returned invalid JSON.'));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error('Z.ai API returned an empty response.'));
          } else {
            resolve(content);
          }
        } else {
          reject(new Error(`Z.ai API error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Z.ai API request timed out.'));
    });
    req.write(body);
    req.end();
  });
}

async function run() {
  const apiKey = core.getInput('ZAI_API_KEY', { required: true });
  core.setSecret(apiKey);
  const model = core.getInput('ZAI_MODEL');
  const systemPrompt = core.getInput('ZAI_SYSTEM_PROMPT');
  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const maxDiffChars = parseInt(core.getInput('MAX_DIFF_CHARS'), 10) || 0;
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);

  const { context } = github;
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request?.number;

  if (!pullNumber) {
    core.setFailed('This action only runs on pull_request events.');
    return;
  }

  const octokit = github.getOctokit(token);

  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const files = await getChangedFiles(octokit, owner, repo, pullNumber);

  const filteredFiles = filterFiles(files, excludePatterns);

  if (excludePatterns.length > 0) {
    const excluded = files.length - filteredFiles.length;
    if (excluded > 0) {
      core.info(`Excluded ${excluded} file(s) matching EXCLUDE_PATTERNS.`);
    }
  }

  if (!filteredFiles.some(f => f.patch)) {
    core.info('No patchable changes found after filtering. Skipping review.');
    return;
  }

  const headSha = context.payload.pull_request.head.sha;
  const priorComments = await getReviewComments(octokit, owner, repo, pullNumber);
  const reviewHistory = getReviewHistory(priorComments);
  const prompt = buildPrompt(filteredFiles, maxDiffChars, reviewHistory, headSha);

  core.info(`Sending ${filteredFiles.length} file(s) to Z.ai for review...`);
  const review = await callZaiApi(apiKey, model, systemPrompt, prompt);
  // A run can finish after a newer synchronize event has started. Never post
  // feedback for a head that is no longer the PR's current revision.
  const currentHeadSha = await getCurrentHeadSha(octokit, owner, repo, pullNumber);
  if (currentHeadSha !== headSha) {
    core.info(`Discarding stale review for ${headSha}; current head is ${currentHeadSha}.`);
    return;
  }

  const body = `## ${reviewerName} — review of ${headSha.slice(0, 12)}\n\n${review}\n\n${COMMENT_MARKER}`;
  // Post each round as a new comment so concurrent runs cannot overwrite
  // earlier review history. The SHA makes each round's evidence explicit.
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
  core.info('Review comment posted.');
}

module.exports = { buildPrompt, getReviewComments, getReviewHistory, getCurrentHeadSha };

if (require.main === module) {
  run().catch(err => core.setFailed(err.message));
}
