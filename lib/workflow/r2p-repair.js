'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeRoundReceipt } = require('../receipts');
const { redactSensitive } = require('../redaction');

const REQUIRED_CMDS = Object.freeze(['r2p-status', 'r2p-reopen', 'r2p-gap-open', 'r2p-continue']);
const MUTATING_ALLOWLIST = new Set(['r2p-reopen', 'r2p-gap-open']);
const STAGE_ORDER = Object.freeze([
  'raw_requirement',
  'requirement_brief',
  'risk_discovery',
  'design',
  'spec',
  'plan'
]);
const OPEN_RUN_STATUSES = new Set([
  'open',
  'active_stage_draft',
  'entry_gate_failed',
  'quality_gate_failed',
  'ready_for_checkpoint_review',
  'checkpoint_review',
  'checkpoint_changes_requested',
  'upstream_gap_routing',
  'checkpoint_approved',
  'next_stage'
]);
const VALID_STAGES = new Set(STAGE_ORDER);
const REVIEW_ARTIFACTS = Object.freeze([
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
]);
const UNSAFE_TEXT_PATTERN = /[`]|(?:\$\()|(?:&&)|(?:\|\|)|[|;<>]/;
const REQUIRED_ACTION_PATTERN = /(?:\braw\s+)?required[_-]?action\s*[:=]\s*[^\s|,;]+/gi;
const REASON_PATTERN = /(\breason\s*[:=]\s*)[^\s|,;]+/gi;
const SECRET_FIELD_PATTERN = /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*[^\s|,;]+/g;

function makeError(code, blockingReason, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.blockingReason = blockingReason;
  Object.assign(error, extra);
  return error;
}

function singleLine(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, ' ').trim();
}

function redactReceiptValue(value) {
  return String(redactSensitive(singleLine(value)))
    .replace(SECRET_FIELD_PATTERN, '[REDACTED:secret-field]')
    .replace(REQUIRED_ACTION_PATTERN, '[REDACTED:instruction]')
    .replace(REASON_PATTERN, '$1[REDACTED:instruction]');
}

function assertSafeText(value, label) {
  const text = singleLine(value);
  if (!text) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} must be non-empty`);
  }
  if (text.includes('\0')) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} must not contain NUL`);
  }
  if (text.length > 240) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} exceeds 240 characters`);
  }
  if (UNSAFE_TEXT_PATTERN.test(text)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} contains shell-like syntax`);
  }
  return text;
}

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(stage);
}

function ensureStage(stage, label = 'owner stage') {
  if (!VALID_STAGES.has(stage)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `invalid ${label}: ${stage || 'none'}`);
  }
  return stage;
}

function ensureContractStage(stage, label) {
  if (!VALID_STAGES.has(stage)) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `r2p-status JSON exposed invalid ${label}: ${stage || 'none'}`
    );
  }
  return stage;
}

function isOpenRunStatus(status) {
  return OPEN_RUN_STATUSES.has(status);
}

function findExecutable(name, options = {}) {
  const envPath = options.env && typeof options.env.PATH === 'string'
    ? options.env.PATH
    : process.env.PATH;
  const candidates = [];
  if (envPath) {
    for (const entry of envPath.split(path.delimiter)) {
      if (!entry) continue;
      candidates.push(path.resolve(entry, name));
    }
  }
  const homeDir = options.homeDir || os.homedir();
  candidates.push(path.join(homeDir, '.req-to-plan', 'bin', name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) continue;
      return fs.realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function resolveR2pCommands(options = {}) {
  const resolved = {};
  for (const name of REQUIRED_CMDS) {
    const commandPath = findExecutable(name, options);
    if (!commandPath) {
      throw makeError(
        'ERR_R2P_COMMAND_UNAVAILABLE',
        'r2p-command-unavailable',
        `required r2p command is unavailable: ${name}`
      );
    }
    resolved[name] = commandPath;
  }
  return resolved;
}

function execFileJson(filePath, argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      filePath,
      argv,
      {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          ...(options.env || {}),
          R2P_JSON: '1'
        },
        shell: false
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({
          stdout: stdout || '',
          stderr: stderr || ''
        });
      }
    );
  });
}

function parseStatusPayload(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch (error) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `r2p-status did not emit valid JSON: ${error.message}`
    );
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const entry = entries.find((candidate) => candidate && typeof candidate === 'object');
  if (!entry || typeof entry.status !== 'string' || typeof entry.current_stage !== 'string') {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      'r2p-status JSON did not expose status/current_stage'
    );
  }
  return { parsed, entries };
}

async function probeJsonContract(paths, options = {}) {
  const result = await execFileJson(paths['r2p-status'], ['--all'], options);
  const payload = parseStatusPayload(result.stdout);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    entries: payload.entries
  };
}

function normalizeOpenRoutesDetail(detail) {
  if (!Array.isArray(detail)) return [];
  return detail.map((route) => {
    if (!route || typeof route !== 'object' || !Object.prototype.hasOwnProperty.call(route, 'owner_stage')) {
      throw makeError(
        'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
        'r2p-json-contract-unavailable',
        'r2p-status JSON did not expose open route owner stage'
      );
    }
    return {
      routeId: route.route_id ? String(route.route_id) : null,
      ownerStage: ensureContractStage(String(route.owner_stage), 'open route owner stage'),
      requiredAction: route.required_action ? singleLine(route.required_action) : ''
    };
  });
}

async function readRunStatus(paths, workId, options = {}) {
  const { entries } = await probeJsonContract(paths, options);
  const entry = entries.find((candidate) => candidate && candidate.work_id === workId);
  if (!entry) {
    throw makeError(
      'ERR_R2P_STATUS_NOT_FOUND',
      'r2p-json-contract-unavailable',
      `r2p-status did not include work_id ${workId}`
    );
  }
  const currentStage = ensureContractStage(String(entry.current_stage), 'current stage');
  const openRoutesDetail = normalizeOpenRoutesDetail(entry.open_routes_detail);
  return {
    workId,
    status: String(entry.status),
    currentStage,
    openRoutesDetail,
    openRouteOwnerStages: openRoutesDetail
      .map((route) => route.ownerStage)
      .filter(Boolean)
  };
}

function findingOwnerStage(finding) {
  if (!finding || typeof finding !== 'object') return null;
  if (finding.owner_stage) return ensureStage(String(finding.owner_stage));
  if (finding.ownerStage) return ensureStage(String(finding.ownerStage));
  return null;
}

function normalizeFindings(findings) {
  return (Array.isArray(findings) ? findings : []).map((finding, index) => {
    const issueId = finding && (finding.issue_id || finding.issueId)
      ? String(finding.issue_id || finding.issueId)
      : `ISSUE-${String(index + 1).padStart(3, '0')}`;
    const ownerStage = findingOwnerStage(finding);
    const reason = finding && (finding.reason || finding.rationale)
      ? String(finding.reason || finding.rationale)
      : '';
    const requiredAction = finding && (finding.required_action || finding.requiredAction)
      ? String(finding.required_action || finding.requiredAction)
      : '';
    return {
      issueId,
      ownerStage,
      reason,
      requiredAction
    };
  });
}

function mapRepairMode(statusOrState, currentStage, findings) {
  const state = typeof statusOrState === 'object' && statusOrState
    ? statusOrState
    : { status: statusOrState, currentStage };
  const liveStatus = String(state.status || '');
  const stage = ensureStage(String(state.currentStage || currentStage), 'current stage');
  const normalizedFindings = normalizeFindings(findings);
  const ownerStages = normalizedFindings.length > 0
    ? normalizedFindings.map((finding) => finding.ownerStage).filter(Boolean)
    : (Array.isArray(state.openRouteOwnerStages) ? state.openRouteOwnerStages : []);

  if (liveStatus === 'closed_at_plan_checkpoint' || liveStatus === 'executing') {
    return {
      kind: 'command',
      command_kind: 'r2p-reopen',
      current_stage: stage
    };
  }
  if (isOpenRunStatus(liveStatus)) {
    const currentIndex = stageIndex(stage);
    const upstream = ownerStages.some((ownerStage) => stageIndex(ownerStage) !== -1 && stageIndex(ownerStage) < currentIndex);
    if (upstream) {
      return {
        kind: 'command',
        command_kind: 'r2p-gap-open',
        current_stage: stage
      };
    }
    const sameStage = ownerStages.some((ownerStage) => ownerStage === stage);
    if (sameStage) {
      return {
        kind: 'checkpoint',
        status: 'checkpoint',
        statusReason: 'r2p-current-stage-repair-required',
        current_stage: stage
      };
    }
  }
  return {
    kind: 'blocked',
    status: 'blocked',
    blockingReason: 'r2p-run-status-unsupported',
    current_stage: stage
  };
}

function earliestOwnerStage(findings) {
  let earliest = null;
  for (const finding of findings) {
    const ownerStage = ensureStage(finding.ownerStage);
    if (!earliest || stageIndex(ownerStage) < stageIndex(earliest)) earliest = ownerStage;
  }
  if (!earliest) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'accepted findings did not map to an owner stage');
  }
  return earliest;
}

function synthesizeReason(commandKind, ownerStage, issueIds) {
  const joinedIds = issueIds.join(', ');
  if (commandKind === 'r2p-gap-open') {
    return `Address accepted findings ${joinedIds} at ${ownerStage}.`;
  }
  return `Reopen ${ownerStage} for accepted findings ${joinedIds}.`;
}

function buildRepairPlan(accepted, mode, currentStage, options = {}) {
  if (!mode || typeof mode !== 'object') {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'repair mode is required');
  }
  if (mode.kind === 'checkpoint') return mode;
  if (mode.kind === 'blocked') {
    throw makeError('ERR_R2P_RUN_STATUS_UNSUPPORTED', mode.blockingReason || 'r2p-run-status-unsupported', 'run status cannot be repaired automatically');
  }
  const normalized = normalizeFindings(accepted);
  if (normalized.length === 0) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'accepted findings are required');
  }
  const ownerStage = earliestOwnerStage(normalized);
  const issueIds = normalized.map((finding) => finding.issueId);
  const stage = ensureStage(String(currentStage || mode.current_stage), 'current stage');
  const currentIndex = stageIndex(stage);
  const ownerIndex = stageIndex(ownerStage);
  if (mode.command_kind === 'r2p-gap-open' && ownerIndex >= currentIndex) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'gap-open owner stage must be strictly upstream');
  }
  const firstWithText = normalized.find((finding) => finding.ownerStage === ownerStage && (finding.reason || finding.requiredAction)) || normalized[0];
  const rawText = mode.command_kind === 'r2p-gap-open'
    ? (firstWithText.requiredAction || synthesizeReason(mode.command_kind, ownerStage, issueIds))
    : (firstWithText.reason || synthesizeReason(mode.command_kind, ownerStage, issueIds));
  const safeText = assertSafeText(rawText, mode.command_kind === 'r2p-gap-open' ? 'required_action' : 'reason');
  return {
    command_kind: mode.command_kind,
    owner_stage: ownerStage,
    issue_ids: issueIds,
    current_stage: stage,
    workId: options.workId || mode.workId || null,
    reason: mode.command_kind === 'r2p-reopen' ? safeText : null,
    required_action: mode.command_kind === 'r2p-gap-open' ? safeText : null
  };
}

function fingerprintRun(runDir, artifactNames = REVIEW_ARTIFACTS) {
  const runMdPath = path.join(runDir, 'run.md');
  const runMdSha256 = crypto.createHash('sha256').update(fs.readFileSync(runMdPath, 'utf8')).digest('hex');
  const fileSetHash = crypto.createHash('sha256');
  for (const artifact of artifactNames) {
    const text = fs.readFileSync(path.join(runDir, artifact), 'utf8');
    fileSetHash.update(artifact);
    fileSetHash.update('\0');
    fileSetHash.update(text);
    fileSetHash.update('\0');
  }
  return {
    runMdSha256,
    fileSetFingerprint: fileSetHash.digest('hex')
  };
}

function statusMatchesCommandKind(commandKind, liveStatus) {
  if (commandKind === 'r2p-reopen') {
    return liveStatus === 'closed_at_plan_checkpoint' || liveStatus === 'executing';
  }
  if (commandKind === 'r2p-gap-open') {
    return isOpenRunStatus(liveStatus);
  }
  return false;
}

async function driftGuard(state) {
  const paths = resolveR2pCommands(state);
  try {
    const activeStats = fs.lstatSync(state.runDir);
    if (!activeStats.isDirectory() || activeStats.isSymbolicLink()) {
      return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'active run directory is missing or unsafe' };
    }
  } catch {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'active run directory is missing or unsafe' };
  }
  if (state.archiveRunDir && fs.existsSync(state.archiveRunDir)) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'run moved to archive after review' };
  }
  const liveFingerprint = fingerprintRun(state.runDir, state.reviewArtifacts || REVIEW_ARTIFACTS);
  if (state.runMdSha256 && liveFingerprint.runMdSha256 !== state.runMdSha256) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'run.md changed after review' };
  }
  if (state.fileSetFingerprint && liveFingerprint.fileSetFingerprint !== state.fileSetFingerprint) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'review artifacts changed after review' };
  }
  const liveStatus = await readRunStatus(paths, state.workId, state);
  if (!statusMatchesCommandKind(state.command_kind, liveStatus.status)) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'live run status no longer matches the repair plan' };
  }
  return {
    ok: true,
    paths,
    liveStatus,
    fingerprint: liveFingerprint
  };
}

function buildArgv(plan) {
  if (plan.command_kind === 'r2p-gap-open') {
    return ['--work-id', plan.workId, '--owner-stage', plan.owner_stage, '--required-action', plan.required_action, '--confirm'];
  }
  return ['--from', plan.workId, '--stage', plan.owner_stage, '--reason', plan.reason];
}

function parseCommandOutput(commandKind, stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch (error) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `${commandKind} did not emit valid JSON: ${error.message}`
    );
  }
  if (commandKind === 'r2p-reopen') {
    if (!parsed || typeof parsed.new_work_id !== 'string') {
      throw makeError('ERR_R2P_JSON_CONTRACT_UNAVAILABLE', 'r2p-json-contract-unavailable', 'r2p-reopen JSON did not expose new_work_id');
    }
  } else if (!parsed || typeof parsed.route_id !== 'string') {
    throw makeError('ERR_R2P_JSON_CONTRACT_UNAVAILABLE', 'r2p-json-contract-unavailable', 'r2p-gap-open JSON did not expose route_id');
  }
  return parsed;
}

function buildNextAction(commandKind, rerunWorkId) {
  const sameWorkId = commandKind === 'r2p-gap-open';
  return sameWorkId
    ? `Run r2p-continue for workId=${rerunWorkId}, then rerun review-fix-r2p workId=${rerunWorkId}.`
    : `Run r2p-continue for workId=${rerunWorkId}, then rerun review-fix-r2p workId=${rerunWorkId}.`;
}

async function runRepairCommand(paths, plan, options = {}) {
  if (!plan || !MUTATING_ALLOWLIST.has(plan.command_kind)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'repair plan command_kind is invalid');
  }
  const bin = paths[plan.command_kind];
  if (!bin || !path.isAbsolute(bin)) {
    throw makeError('ERR_R2P_COMMAND_UNAVAILABLE', 'r2p-command-unavailable', `resolved command path is missing for ${plan.command_kind}`);
  }
  const argv = buildArgv(plan);
  let execution;
  try {
    execution = await execFileJson(bin, argv, options);
  } catch (error) {
    throw makeError(
      'ERR_R2P_COMMAND_FAILED',
      'r2p-command-failed',
      `${plan.command_kind} failed with exit code ${typeof error.code === 'number' ? error.code : 'unknown'}`,
      {
        exitCode: typeof error.code === 'number' ? error.code : null,
        stdout: error.stdout || '',
        stderr: error.stderr || ''
      }
    );
  }
  const parsed = parseCommandOutput(plan.command_kind, execution.stdout);
  const newWorkId = plan.command_kind === 'r2p-reopen' ? parsed.new_work_id : null;
  const routeId = plan.command_kind === 'r2p-gap-open' ? parsed.route_id : null;
  const staledStages = plan.command_kind === 'r2p-gap-open' && Array.isArray(parsed.staled_stages)
    ? parsed.staled_stages.map((stage) => String(stage))
    : [];
  const rerunWorkId = newWorkId || plan.workId;
  return {
    command: plan.command_kind,
    argv,
    exitCode: 0,
    stdout: execution.stdout,
    stderr: execution.stderr,
    parsed,
    workId: plan.workId,
    newWorkId,
    routeId,
    staledStages,
    nextAction: buildNextAction(plan.command_kind, rerunWorkId),
    status: 'checkpoint',
    statusReason: 'r2p-repair-applied',
    issueIds: plan.issue_ids || []
  };
}

function redactedArgv(argv) {
  const reduced = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    reduced.push(item);
    if ((item === '--reason' || item === '--required-action') && index + 1 < argv.length) {
      reduced.push('[REDACTED]');
      index += 1;
    }
  }
  return reduced;
}

function formatReceiptText(result) {
  const summaryLines = [
    `Command: ${result.command || 'none'}`,
    `Argv: ${(redactedArgv(result.argv || [])).join(' ') || 'none'}`,
    `Exit code: ${result.exitCode === null || result.exitCode === undefined ? 'none' : String(result.exitCode)}`,
    `Stdout: ${redactReceiptValue(result.stdout || 'none')}`,
    `Stderr: ${redactReceiptValue(result.stderr || 'none')}`
  ];
  if (result.newWorkId) summaryLines.push(`New work ID: ${redactReceiptValue(result.newWorkId)}`);
  if (result.routeId) summaryLines.push(`Route ID: ${redactReceiptValue(result.routeId)}`);
  if (Array.isArray(result.staledStages) && result.staledStages.length > 0) {
    summaryLines.push(`Staled stages: ${result.staledStages.map((stage) => redactReceiptValue(stage)).join(', ')}`);
  }
  return summaryLines.join('\n');
}

function writeReceipt(result) {
  const text = formatReceiptText(result);
  if (result && result.projectRoot && result.targetKey && result.round) {
    const receiptPath = writeRoundReceipt({
      projectRoot: result.projectRoot,
      targetKey: result.targetKey,
      round: result.round,
      kind: result.kind || 'r2p-repair',
      status: result.status || 'checkpoint',
      stopReason: 'checkpoint',
      target: `workId=${result.workId || 'none'}`,
      issueIds: result.issueIds || [],
      filesChanged: 'none',
      verification: 'argv-array execFile shell:false R2P_JSON=1',
      blockingReason: result.blockingReason || 'none',
      statusReason: result.statusReason || 'r2p-repair-applied',
      summary: text,
      nextAction: result.nextAction || 'run r2p-continue and rerun review-fix-r2p'
    });
    return {
      receiptPath,
      receiptText: fs.readFileSync(receiptPath, 'utf8')
    };
  }
  const receiptText = redactReceiptValue(text);
  if (result && result.receiptPath) {
    fs.mkdirSync(path.dirname(result.receiptPath), { recursive: true });
    fs.writeFileSync(result.receiptPath, `${receiptText}\n`, 'utf8');
  }
  return {
    receiptPath: result && result.receiptPath ? result.receiptPath : null,
    receiptText
  };
}

module.exports = {
  resolveR2pCommands,
  probeJsonContract,
  readRunStatus,
  mapRepairMode,
  buildRepairPlan,
  driftGuard,
  runRepairCommand,
  writeReceipt
};
