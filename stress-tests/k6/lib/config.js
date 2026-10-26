// Shared k6 configuration and load profiles.
// All values come from environment variables so the same script runs in CI and locally.

export function loadConfig() {
  var targetRps = Number(__ENV.TARGET_RPS || 20);
  var profile = __ENV.PROFILE || 'smoke';
  var duration = __ENV.DURATION || '';
  var preAllocatedVUs = Number(__ENV.PRE_VUS || Math.max(10, Math.ceil(targetRps * 2)));
  var maxVUs = Number(__ENV.MAX_VUS || Math.max(50, Math.ceil(targetRps * 10)));

  return {
    baseUrl: (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    token: __ENV.TOKEN || 'replace-me',
    tableId: __ENV.TABLE_ID || 'tbl_replace_me',
    viewId: __ENV.VIEW_ID || '',
    recordIdsFile: __ENV.RECORD_IDS_FILE || '../../data/ids.example.json',
    runId: __ENV.RUN_ID || 'lst_local_smoke_0000000',
    apiKind: __ENV.API_KIND || 'v1',
    profile: profile,
    targetRps: targetRps,
    duration: duration,
    preAllocatedVUs: preAllocatedVUs,
    maxVUs: maxVUs,
    readMode: __ENV.READ_MODE || 'mixed',
    writeMode: __ENV.WRITE_MODE || 'cycle',
    mix: __ENV.MIX || 'read',
    take: Number(__ENV.TAKE || 100),
    filterJson: __ENV.FILTER_JSON || '',
    sortJson: __ENV.SORT_JSON || '',
    groupJson: __ENV.GROUP_JSON || '',
    projection: __ENV.PROJECTION || '',
    pageMode: __ENV.PAGE_MODE || 'offset',
    skip: Number(__ENV.SKIP || 0),
    cursor: __ENV.CURSOR || '',
    includeTotal: __ENV.INCLUDE_TOTAL === 'true',
    batchSize: Number(__ENV.BATCH_SIZE || 100),
    fieldName: __ENV.FIELD_NAME || 'Name',
    fieldValuePrefix: __ENV.FIELD_VALUE_PREFIX || 'loadtest',
    searchProbe: __ENV.SEARCH_PROBE || 'order',
    sourceRecordId: __ENV.SOURCE_RECORD_ID || '',
    updateField: __ENV.UPDATE_FIELD || '',
    updateValue: __ENV.UPDATE_VALUE || '',
    expectedStatus: Number(__ENV.EXPECTED_STATUS || 0),
  };
}

function stageOptions(cfg, stages) {
  return {
    executor: 'ramping-arrival-rate',
    startRate: 0,
    timeUnit: '1s',
    preAllocatedVUs: cfg.preAllocatedVUs,
    maxVUs: cfg.maxVUs,
    stages: stages,
  };
}

function constantOptions(cfg, rate, duration) {
  return {
    executor: 'constant-arrival-rate',
    rate: Math.max(1, Math.round(rate)),
    timeUnit: '1s',
    duration: duration,
    preAllocatedVUs: cfg.preAllocatedVUs,
    maxVUs: cfg.maxVUs,
  };
}

export function scenarioOptions(cfg, kind) {
  var base = {
    discardResponseBodies: false,
    summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
    userAgent: 'teable-stress-testing/1.0',
    thresholds: {
      http_req_failed: ['rate<0.02'],
    },
  };

  var profile = cfg.profile;
  var target = cfg.targetRps;
  var duration = cfg.duration || (kind === 'soak' ? '2h' : '20m');

  if (profile === 'smoke') {
    base.scenarios = { [kind]: constantOptions(cfg, Math.min(5, Math.max(1, target)), __ENV.SMOKE_DURATION || '30s') };
    return base;
  }

  if (profile === 'load') {
    base.scenarios = {
      [kind]: stageOptions(cfg, [
        { target: Math.ceil(target * 0.1), duration: '1m' },
        { target: target, duration: duration },
        { target: 0, duration: '1m' },
      ]),
    };
    return base;
  }

  if (profile === 'stress') {
    base.scenarios = {
      [kind]: stageOptions(cfg, [
        { target: Math.ceil(target * 0.25), duration: '2m' },
        { target: Math.ceil(target * 2), duration: '5m' },
        { target: Math.ceil(target * 3), duration: '5m' },
        { target: Math.ceil(target * 3), duration: duration },
        { target: 0, duration: '2m' },
      ]),
    };
    return base;
  }

  if (profile === 'soak') {
    base.scenarios = { [kind]: constantOptions(cfg, Math.max(1, target * 0.7), duration) };
    return base;
  }

  if (profile === 'spike') {
    base.scenarios = {
      [kind]: stageOptions(cfg, [
        { target: Math.ceil(target * 0.5), duration: '2m' },
        { target: Math.ceil(target * 5), duration: '1m' },
        { target: Math.ceil(target * 5), duration: '2m' },
        { target: 0, duration: '1m' },
      ]),
    };
    return base;
  }

  if (profile === 'breakpoint') {
    base.scenarios = {
      [kind]: stageOptions(cfg, [
        { target: Math.ceil(target * 0.25), duration: '2m' },
        { target: Math.ceil(target * 0.5), duration: '3m' },
        { target: Math.ceil(target * 1), duration: '5m' },
        { target: Math.ceil(target * 2), duration: '5m' },
        { target: Math.ceil(target * 3), duration: '5m' },
        { target: 0, duration: '1m' },
      ]),
    };
    return base;
  }

  throw new Error('Unknown PROFILE: ' + profile);
}
