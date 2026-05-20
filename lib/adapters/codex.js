'use strict';

async function checkCapabilities() {
  return {
    can_spawn_isolated_reviewer: {
      status: 'unverified',
      proof: 'none',
      proofRunId: 'none',
      detail: 'No non-interactive reviewer isolation proof is available.'
    },
    reviewer_write_blocked: {
      status: 'unverified',
      proof: 'none',
      proofRunId: 'none',
      detail: 'Prompt-only read-only instructions are not proof of write blocking.'
    }
  };
}

module.exports = { checkCapabilities };
