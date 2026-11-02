const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, getReviewComments, getReviewHistory } = require('../src');

test('follow-up prompts include prior findings and require evidence from the current diff', () => {
  const prompt = buildPrompt([
    { filename: 'src/example.js', status: 'modified', patch: '@@ -1 +1 @@\n-old()\n+new()' },
  ], 0, '## Prior review\nFinding: unsafe call', 'abc123');

  assert.match(prompt, /head abc123/);
  assert.match(prompt, /unsafe call/);
  assert.match(prompt, /does not provide enough evidence/);
  assert.match(prompt, /Current diff/);
});

test('review history collects marked rounds in chronological order and keeps each round', () => {
  const history = getReviewHistory([
    { body: 'Second round\n\n<!-- zai-code-review -->', created_at: '2026-01-02' },
    { body: 'First round\n\n<!-- zai-code-review -->', created_at: '2026-01-01' },
    { body: 'unmarked comment', created_at: '2026-01-03' },
  ]);
  assert.equal(history, 'First round\n\n---\n\nSecond round');
});

test('review comment retrieval paginates and filters unmarked comments', async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => ({ body: `page one ${index}`, created_at: '2026-01-01' })),
    [
      { body: 'review <!-- zai-code-review -->', created_at: '2026-01-02' },
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
