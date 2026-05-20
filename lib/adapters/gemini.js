'use strict';

async function checkCapabilities() {
  return {
    can_spawn_isolated_reviewer: {
      status: 'unsupported',
      proof: 'none',
      proofRunId: 'none',
      detail: 'Gemini v1 route is advisory-only.'
    },
    reviewer_write_blocked: {
      status: 'unsupported',
      proof: 'none',
      proofRunId: 'none',
      detail: 'Gemini v1 has no verified write-blocked reviewer adapter.'
    }
  };
}

module.exports = { checkCapabilities };
