'use strict';

// Golden-snapshot support for generated route SHELLS.
//
// A route "shell" is the rendered platform route with the {{EMBEDDED_SHARED_CONTENT}}
// expansion replaced by a stable sentinel. The embedded shared content
// (shared/core.md, long-task.md, prompts, rubrics) is owned by a separate task
// (PLAN-TASK-009); masking it here keeps the shell snapshot focused on the
// route protocol/contract text that PLAN-TASK-008 owns.
//
// Masking markers (verified against the three templates):
// - Claude/Codex: the `## Embedded Shared Content` heading begins the expansion,
//   which then contains generated `<!-- shared/... -->` chunk markers. Everything
//   from that heading to end-of-file is the expansion.
// - Gemini: `Embedded shared content:` begins the expansion inside the TOML
//   prompt string; the expansion runs to the closing `'''` line.

const fs = require('node:fs');
const path = require('node:path');

const SENTINEL = '<<<EMBEDDED_SHARED_CONTENT_MASKED>>>';

const EXTENSION_BY_PLATFORM = Object.freeze({
  claude: 'md',
  codex: 'md',
  gemini: 'toml'
});

/**
 * Replace the {{EMBEDDED_SHARED_CONTENT}} expansion in a rendered route with a
 * stable sentinel, leaving the rest of the shell (including the rendered
 * {{RUNTIME_FLAGS}} partial) intact.
 *
 * @param {string} platform - 'claude' | 'codex' | 'gemini'
 * @param {string} rendered - full rendered route text
 * @returns {string} the route shell with embedded shared content masked
 */
function maskEmbeddedSharedContent(platform, rendered) {
  if (platform === 'claude' || platform === 'codex') {
    const heading = '## Embedded Shared Content';
    const index = rendered.indexOf(heading);
    if (index === -1) {
      throw new Error(`route shell mask: missing "${heading}" marker for ${platform}`);
    }
    return `${rendered.slice(0, index)}${heading}\n\n${SENTINEL}\n`;
  }

  if (platform === 'gemini') {
    const marker = 'Embedded shared content:';
    const markerIndex = rendered.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error('route shell mask: missing "Embedded shared content:" marker for gemini');
    }
    // The TOML prompt string is closed by a line that is exactly `'''`.
    const closingIndex = rendered.indexOf("\n'''", markerIndex);
    if (closingIndex === -1) {
      throw new Error('route shell mask: missing closing triple-quote after gemini embedded content');
    }
    const head = rendered.slice(0, markerIndex);
    const tail = rendered.slice(closingIndex); // begins with "\n'''"
    return `${head}${marker}\n\n${SENTINEL}${tail}`;
  }

  throw new Error(`route shell mask: unsupported platform: ${platform}`);
}

function snapshotPath(platform, routeName) {
  const extension = EXTENSION_BY_PLATFORM[platform];
  return path.join(__dirname, '..', 'fixtures', 'generated', platform, `${routeName}.${extension}`);
}

function readSnapshot(platform, routeName) {
  return fs.readFileSync(snapshotPath(platform, routeName), 'utf8');
}

/**
 * Normalize a route shell for the "byte-identical EXCEPT additive rounds=<n>"
 * comparison. The ONLY allowed additive change to document routes in
 * PLAN-TASK-008 is the `rounds=<n>` token in the invocation grammar and the
 * propagated `rounds=<value>` materialization on workflow commands. Stripping
 * those occurrences lets the pre-rounds snapshot and the post-rounds regenerated
 * shell compare equal, while any OTHER drift still fails loudly.
 *
 * Removes, in the grammar/command surfaces only:
 * - ` [rounds=<n>]` grammar option (with surrounding single space)
 * - ` rounds=<value>` materialized token in `drfx workflow` command lines
 */
function stripAdditiveRounds(text) {
  return text
    // grammar option form: "... [resume] [rounds=<n>] [ledger=...]" -> drop the bracketed option
    .replace(/ \[rounds=<n>\]/g, '')
    // materialized command token form: "... review-and-fix rounds=<roundLimit> guard=..." -> drop token
    .replace(/ rounds=<[^>]+>/g, '');
}

/**
 * Return the {{EMBEDDED_SHARED_CONTENT}} expansion (heading/marker + body) that
 * maskEmbeddedSharedContent() replaces. This is the prompt/rubric/core text that
 * the shell snapshot intentionally masks out, snapshotted here so any wording
 * change in shared prompts or rubrics is forced through explicit review.
 *
 * Inverse of maskEmbeddedSharedContent(): the two functions share the same
 * markers and slice boundaries and MUST stay in sync — edit them together.
 */
function extractEmbeddedSharedContent(platform, rendered) {
  if (platform === 'claude' || platform === 'codex') {
    const heading = '## Embedded Shared Content';
    const index = rendered.indexOf(heading);
    if (index === -1) {
      throw new Error(`embedded extract: missing "${heading}" marker for ${platform}`);
    }
    return rendered.slice(index);
  }

  if (platform === 'gemini') {
    const marker = 'Embedded shared content:';
    const markerIndex = rendered.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error('embedded extract: missing "Embedded shared content:" marker for gemini');
    }
    const closingIndex = rendered.indexOf("\n'''", markerIndex);
    if (closingIndex === -1) {
      throw new Error('embedded extract: missing closing triple-quote after gemini embedded content');
    }
    return rendered.slice(markerIndex, closingIndex);
  }
  throw new Error(`embedded extract: unsupported platform: ${platform}`);
}

function embeddedSnapshotPath(platform, routeName) {
  const extension = EXTENSION_BY_PLATFORM[platform];
  return path.join(__dirname, '..', 'fixtures', 'embedded', platform, `${routeName}.${extension}`);
}

function readEmbeddedSnapshot(platform, routeName) {
  return fs.readFileSync(embeddedSnapshotPath(platform, routeName), 'utf8');
}

module.exports = {
  SENTINEL,
  EXTENSION_BY_PLATFORM,
  maskEmbeddedSharedContent,
  snapshotPath,
  readSnapshot,
  stripAdditiveRounds,
  extractEmbeddedSharedContent,
  embeddedSnapshotPath,
  readEmbeddedSnapshot
};
