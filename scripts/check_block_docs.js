#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
// CI gate: regenerates docs/block-reference and fails on any diff.
// Usage: node scripts/check_block_docs.js
'use strict';
const { execSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

try {
  run('node build_block_docs.js');
} catch (e) {
  console.error('check_block_docs: build_block_docs.js failed');
  process.exit(e.status || 1);
}

// Use git diff to detect drift. --exit-code returns 1 when diff found.
const result = spawnSync('git', ['diff', '--exit-code', '--', 'docs/block-reference/'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (result.status === 0) {
  console.log('check_block_docs: PASS - docs/block-reference is up to date.');
  process.exit(0);
} else if (result.status === 1) {
  console.error('check_block_docs: FAIL - docs/block-reference is stale. Run `node build_block_docs.js` and commit the result.');
  // Show which files differed for convenience
  try {
    execSync('git diff --stat -- docs/block-reference/', { stdio: 'inherit', cwd: ROOT });
  } catch (_) {}
  process.exit(1);
} else {
  console.error(`check_block_docs: git diff failed with status ${result.status}`);
  process.exit(result.status || 1);
}
