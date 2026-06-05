'use strict';

// gitignore-syntax matcher for `.drfxignore` (PURE, zero-dependency).
//
// `.drfxignore` shares `.gitignore` pattern semantics so users carry one
// mental model: `#` comments, blank lines, trailing-space trimming (unless
// backslash-escaped), `!` negation with last-match-wins, leading-`/`
// anchoring, trailing-`/` directory-only patterns, `*` / `?` / `[...]`
// wildcards, and `**` path-spanning globs. The file lives ONLY at the
// project root, so every pattern is evaluated against root-relative posix
// paths (no nested ignore files).
//
// Evaluation uses git's pruning model: when a DIRECTORY matches, traversal
// stops there, so a negation can never re-include content below an excluded
// directory — exactly git's documented behavior ("It is not possible to
// re-include a file if a parent directory of that file is excluded").
//
// Pattern-to-RegExp conversion is intentionally defensive: a malformed
// pattern (e.g. an unterminated character class) degrades to matching its
// literal text instead of throwing, because matcher construction runs inside
// identity derivation, which must never crash on user config.

// Translate one gitignore glob (already stripped of `!`, anchors decided by
// the caller) into a RegExp source fragment for one path.
function globToRegExpSource(glob) {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**` handling by position:
        //   leading `**/`  → any number of leading segments
        //   trailing `/**` → everything inside (caller appends, see below)
        //   `a/**/b`       → zero or more whole segments
        // Consecutive-with-more-stars or other placements degrade to `*`
        // pairs, mirroring git's "other consecutive asterisks" rule.
        const prevIsBoundary = index === 0 || glob[index - 1] === '/';
        const next = glob[index + 2];
        if (prevIsBoundary && next === '/') {
          source += '(?:[^/]+/)*';
          index += 3;
          continue;
        }
        if (prevIsBoundary && next === undefined) {
          source += '.*';
          index += 2;
          continue;
        }
        source += '[^/]*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      // Character class: find the closing bracket, honoring a leading `!`/`^`
      // negation and a literal `]` right after the (negated) opening.
      let scan = index + 1;
      let body = '';
      let negated = false;
      if (glob[scan] === '!' || glob[scan] === '^') {
        negated = true;
        scan += 1;
      }
      if (glob[scan] === ']') {
        body += '\\]';
        scan += 1;
      }
      while (scan < glob.length && glob[scan] !== ']') {
        const inner = glob[scan];
        body += /[\\^$.|?*+()[{]/.test(inner) ? `\\${inner}` : inner;
        scan += 1;
      }
      if (scan < glob.length && body !== '') {
        source += `[${negated ? '^' : ''}${body}]`;
        index = scan + 1;
        continue;
      }
      // Unterminated/empty class: treat `[` as a literal character.
      source += '\\[';
      index += 1;
      continue;
    }
    if (char === '\\' && index + 1 < glob.length) {
      // Backslash escapes the next character (e.g. `\#`, `\!`, `\ `).
      const escaped = glob[index + 1];
      source += /[\\^$.|?*+()[\]{}]/.test(escaped) ? `\\${escaped}` : escaped;
      index += 2;
      continue;
    }
    source += /[\\^$.|?*+()[\]{}]/.test(char) ? `\\${char}` : char;
    index += 1;
  }
  return source;
}

// Compile one non-comment .drfxignore line into a rule, or null when the
// line carries no pattern. Mirrors gitignore line semantics.
function compilePattern(rawLine) {
  // Trailing spaces are ignored unless the last one is backslash-escaped.
  let line = rawLine.replace(/(?<!\\)\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  if (line === '') return null;

  let directoryOnly = false;
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    directoryOnly = true;
    line = line.replace(/\/+$/, '');
  }
  if (line === '') return null;

  // A separator anywhere except the very end anchors the pattern to the
  // root; otherwise it matches the basename at ANY depth.
  const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
  const glob = line.replace(/^\/+/, '');
  if (glob === '') return null;

  let source;
  if (anchored) {
    source = `^${globToRegExpSource(glob)}$`;
  } else {
    source = `(?:^|/)${globToRegExpSource(glob)}$`;
  }

  let regExp;
  try {
    regExp = new RegExp(source);
  } catch {
    // Defensive: degrade to literal-text matching, never throw.
    const literal = glob.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
    regExp = new RegExp(anchored ? `^${literal}$` : `(?:^|/)${literal}$`);
  }
  return { negated, directoryOnly, regExp, pattern: rawLine.trim() };
}

/**
 * Build a matcher over `.drfxignore` content.
 *
 * @param {string} content - raw .drfxignore file content
 * @returns {{ ignores(relativePath: string, isDirectory: boolean): boolean,
 *             patterns: string[] }}
 *   `ignores` evaluates ONE root-relative posix path (no leading slash)
 *   against the rules with last-match-wins semantics. Callers implement the
 *   pruning model: a matched directory is pruned, so descendants are never
 *   queried. `patterns` are the normalized non-comment lines in file order
 *   (exact duplicates collapsed) — the deterministic identity input.
 */
function createDrfxignoreMatcher(content) {
  const rules = [];
  const patterns = [];
  const seen = new Set();
  for (const rawLine of String(content).split(/\r?\n/)) {
    const rule = compilePattern(rawLine);
    if (!rule) continue;
    rules.push(rule);
    if (!seen.has(rule.pattern)) {
      seen.add(rule.pattern);
      patterns.push(rule.pattern);
    }
  }

  function ignores(relativePath, isDirectory) {
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.regExp.test(relativePath)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  return { ignores, patterns };
}

module.exports = {
  createDrfxignoreMatcher
};
