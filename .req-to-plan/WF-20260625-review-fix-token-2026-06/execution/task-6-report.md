# PLAN-TASK-006 Report

## Summary

- Updated `README.md` and `README.zh-CN.md` to document workflow JSON modes, generated-route compact defaults, full/debug artifact path diagnostics, and safe document `fix-report-mismatch` retry behavior.
- Updated `test/readme-content.test.js` to assert compact/full JSON documentation, full/debug artifact path guidance, safe retry vs reset/manual recovery wording, and literal parity across both README files.

## RED

- `node --test test/readme-content.test.js`
  - Failed as expected before README changes.
  - Summary: 27 passed, 4 failed.
  - Failures covered missing `--json=full`, missing full/debug artifact path guidance, missing `fix-report-mismatch` retry guidance, and missing critical literals.

## GREEN

- `node --test test/readme-content.test.js`
  - Passed: 31/31.
- `node --test test/workflow-args.test.js test/workflow-json-baseline.test.js test/cli.test.js`
  - Passed: 74/74.
- `node --test test/shared-assets.test.js test/workflow-json-baseline.test.js`
  - Passed: 106/106.
- `node --test test/semantic-parsers.test.js test/workflow-e2e.test.js --test-name-pattern="fix report|Verification|end-fix"`
  - Passed: 83/83.
- `node --test --test-name-pattern="fix-report-mismatch|begin-fix retry|diff-review" test/workflow-e2e.test.js`
  - Passed: 17/17.
- `npm run syntaxcheck`
  - Passed: syntax check passed, 98 files checked.
- `npm test`
  - Passed: 1268/1268.

## Residual Risk

- None identified.
