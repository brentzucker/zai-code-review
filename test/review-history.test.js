const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, getReviewComments, getReviewHistory, getReviewDiff, getLastReviewedSha, postReviewIfCurrent } = require('../src');

test('follow-up prompts include prior findings and require evidence from the current diff', () => {
  const prompt = buildPrompt([
    { filename: 'src/example.js', status: 'modified', patch: '@@ -1 +1 @@\n-old()\n+new()' },
  ], 0, '## Prior review\nFinding: unsafe call', 'abc123');

  assert.match(prompt, /head abc123/);
  assert.match(prompt, /unsafe call/);
  assert.match(prompt, /UNVERIFIABLE/);
  assert.match(prompt, /Current diff/);
});

test('review history collects marked rounds in chronological order and keeps each round', () => {
  const history = getReviewHistory([
    { body: 'Second round\n\n<!-- zai-code-review -->', created_at: '2026-01-02', user: { type: 'Bot' } },
    { body: 'First round\n\n<!-- zai-code-review -->', created_at: '2026-01-01', user: { type: 'Bot' } },
    { body: 'spoof <!-- zai-code-review -->', created_at: '2026-01-03', user: { type: 'User' } },
  ]);
  assert.equal(history, 'First round\n\n---\n\nSecond round');
});

test('review comment retrieval paginates and filters unmarked comments', async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => ({ body: `page one ${index}`, created_at: '2026-01-01' })),
    [
      { body: 'review <!-- zai-code-review -->', created_at: '2026-01-02', user: { type: 'Bot' } },
      { body: 'spoof <!-- zai-code-review -->', created_at: '2026-01-02', user: { type: 'User' } },
      { body: 'ordinary comment', created_at: '2026-01-03' },
    ],
  ];
  const calls = [];
  const octokit = { rest: { issues: { listComments: async params => {
    calls.push(params.page);
    return { data: pages[params.page - 1] };
  } } } };

  const comments = await getReviewComments(octokit, 'owner', 'repo', 1);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /zai-code-review/);
});

test('follow-up diff compares the previous reviewed SHA with the current SHA', async () => {
  const calls = [];
  const octokit = {
    rest: {
      repos: { compareCommitsWithBasehead: async params => {
        calls.push(params);
        return { data: { files: [{ filename: 'src/fix.js', patch: '+fixed' }] } };
      } },
      pulls: { listFiles: async () => { throw new Error('full PR diff should not be used'); } },
    },
  };
  const files = await getReviewDiff(octokit, 'owner', 'repo', 7, 'a'.repeat(40), 'b'.repeat(40));
  assert.deepEqual(calls, [{ owner: 'owner', repo: 'repo', basehead: `${'a'.repeat(40)}...${'b'.repeat(40)}`, per_page: 100 }]);
  assert.equal(files[0].filename, 'src/fix.js');
});

test('history is bounded and latest review SHA is read from bot-authored comments only', () => {
  const sha = 'c'.repeat(40);
  const comments = [
    { body: `## Review of 1234567\nold finding\n<!-- zai-code-review -->`, created_at: '2026-01-01', user: { type: 'Bot' } },
    { body: `## Review of abcdef0\nspoof\n<!-- zai-code-review head:${'d'.repeat(40)} -->`, created_at: '2026-01-03', user: { type: 'User' } },
    { body: `## Review of ${sha.slice(0, 12)}\n${'x'.repeat(100)}\n<!-- zai-code-review -->\n<!-- zai-code-review head:${sha} -->`, created_at: '2026-01-02', user: { type: 'Bot' } },
  ];
  assert.equal(getLastReviewedSha(comments), sha);
  assert.ok(getReviewHistory(comments, 50).length < 150);
  assert.doesNotMatch(getReviewHistory(comments, 50), /spoof/);
});

test('compiled action executes its entrypoint and reports missing required input', () => {
  const { spawnSync } = require('node:child_process');
  const { join } = require('node:path');
  const result = spawnSync(process.execPath, [join(__dirname, '../dist/index.js')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Input required and not supplied: ZAI_API_KEY/);
});

test('a review that becomes stale during comment creation is removed', async () => {
  const heads = ['a'.repeat(40), 'b'.repeat(40)];
  const deleted = [];
  const octokit = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: heads.shift() } } }) },
      issues: {
        createComment: async () => ({ data: { id: 42 } }),
        deleteComment: async params => { deleted.push(params.comment_id); },
      },
    },
  };
  assert.equal(await postReviewIfCurrent(octokit, 'owner', 'repo', 1, 'a'.repeat(40), 'body'), false);
  assert.deepEqual(deleted, [42]);
});
