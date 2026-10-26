import { SharedArray } from 'k6/data';
import { loadConfig, scenarioOptions } from '../lib/config.js';
import { doRequest, randomItem } from '../lib/http.js';
import { makeHandleSummary } from '../lib/summary.js';

var cfg = loadConfig();

var ids = new SharedArray('record_ids', function () {
  return JSON.parse(open(cfg.recordIdsFile));
});

export var options = Object.assign({}, scenarioOptions(cfg, 'computed'), {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    dropped_iterations: ['count<100'],
    'teable_op_duration{op:computed_update}': ['p(95)<800', 'p(99)<2000'],
  },
});

export var handleSummary = makeHandleSummary('summary-computed.json');

function sourceId() {
  if (cfg.sourceRecordId) return cfg.sourceRecordId;
  return randomItem(ids);
}

function updateValue() {
  if (cfg.updateValue) return cfg.updateValue + '-' + __ITER;
  return 'computed-' + cfg.runId + '-' + __VU + '-' + __ITER;
}

export default function () {
  var recordId = sourceId();
  if (!recordId || recordId.indexOf('rec_replace') === 0) return;

  var field = cfg.updateField || cfg.fieldName;
  var value = updateValue();

  if (cfg.apiKind === 'v2') {
    doRequest(
      cfg,
      'POST',
      cfg.baseUrl + '/api/v2/tables/updateRecord',
      {
        tableId: cfg.tableId,
        recordId: recordId,
        fieldKeyType: 'name',
        typecast: false,
        fields: { [field]: value },
      },
      'computed_update',
      200
    );
    return;
  }

  doRequest(
    cfg,
    'PATCH',
    cfg.baseUrl +
      '/api/table/' +
      encodeURIComponent(cfg.tableId) +
      '/record/' +
      encodeURIComponent(recordId),
    {
      fieldKeyType: 'name',
      typecast: false,
      record: { fields: { [field]: value } },
    },
    'computed_update',
    200
  );
}
