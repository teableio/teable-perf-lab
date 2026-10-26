import { SharedArray } from 'k6/data';
import { loadConfig, scenarioOptions } from '../lib/config.js';
import { doRequest, extractRecordId, randomItem, valueFor } from '../lib/http.js';
import { makeHandleSummary } from '../lib/summary.js';

var cfg = loadConfig();

var ids = new SharedArray('record_ids', function () {
  return JSON.parse(open(cfg.recordIdsFile));
});

function hasRealIds() {
  return ids.length > 0 && String(ids[0]).indexOf('rec_replace') !== 0;
}

export var options = Object.assign({}, scenarioOptions(cfg, 'write'), {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    dropped_iterations: ['count<100'],
    'teable_op_duration{op:create}': ['p(95)<800', 'p(99)<2000'],
    'teable_op_duration{op:update}': ['p(95)<800', 'p(99)<2000'],
    'teable_op_duration{op:delete}': ['p(95)<800', 'p(99)<2000'],
    'teable_op_duration{op:batch_update}': ['p(95)<60000', 'p(99)<120000'],
  },
});

export var handleSummary = makeHandleSummary('summary-write.json');

function createRecord() {
  var value = valueFor(cfg);
  if (cfg.apiKind === 'v2') {
    return doRequest(
      cfg,
      'POST',
      cfg.baseUrl + '/api/v2/tables/createRecord',
      {
        tableId: cfg.tableId,
        fieldKeyType: 'name',
        typecast: false,
        fields: { [cfg.fieldName]: value },
      },
      'create',
      201
    );
  }
  return doRequest(
    cfg,
    'POST',
    cfg.baseUrl + '/api/table/' + encodeURIComponent(cfg.tableId) + '/record',
    {
      fieldKeyType: 'name',
      typecast: false,
      records: [{ fields: { [cfg.fieldName]: value } }],
    },
    'create',
    201
  );
}

function updateRecord(recordId) {
  var value = valueFor(cfg);
  if (cfg.apiKind === 'v2') {
    return doRequest(
      cfg,
      'POST',
      cfg.baseUrl + '/api/v2/tables/updateRecord',
      {
        tableId: cfg.tableId,
        recordId: recordId,
        fieldKeyType: 'name',
        typecast: false,
        fields: { [cfg.fieldName]: value },
      },
      'update',
      200
    );
  }
  return doRequest(
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
      record: { fields: { [cfg.fieldName]: value } },
    },
    'update',
    200
  );
}

function deleteRecord(recordId) {
  if (cfg.apiKind === 'v2') {
    return doRequest(
      cfg,
      'DELETE',
      cfg.baseUrl + '/api/v2/tables/deleteRecords',
      { tableId: cfg.tableId, recordIds: [recordId] },
      'delete',
      200
    );
  }
  return doRequest(
    cfg,
    'DELETE',
    cfg.baseUrl +
      '/api/table/' +
      encodeURIComponent(cfg.tableId) +
      '/record?recordIds=' +
      encodeURIComponent(recordId),
    null,
    'delete',
    200
  );
}

function batchUpdate() {
  var records = [];
  for (var i = 0; i < cfg.batchSize; i++) {
    var recordId = randomItem(ids);
    if (!recordId || recordId.indexOf('rec_replace') === 0) continue;
    var fields = {};
    fields[cfg.fieldName] = valueFor(cfg);
    records.push({ id: recordId, fields: fields });
  }
  if (records.length === 0) return null;

  if (cfg.apiKind === 'v2') {
    return doRequest(
      cfg,
      'POST',
      cfg.baseUrl + '/api/v2/tables/updateRecords',
      {
        tableId: cfg.tableId,
        fieldKeyType: 'name',
        typecast: false,
        records: records,
      },
      'batch_update',
      200
    );
  }
  return doRequest(
    cfg,
    'PATCH',
    cfg.baseUrl + '/api/table/' + encodeURIComponent(cfg.tableId) + '/record',
    {
      fieldKeyType: 'name',
      typecast: false,
      records: records,
    },
    'batch_update',
    200
  );
}

export default function () {
  var mode = cfg.writeMode;

  if ((mode === 'update' || mode === 'batch_update') && !hasRealIds()) {
    throw new Error('WRITE_MODE=' + mode + ' needs RECORD_IDS_FILE with real record IDs');
  }

  if (mode === 'create') {
    createRecord();
    return;
  }
  if (mode === 'update') {
    var updateId = randomItem(ids);
    if (updateId && updateId.indexOf('rec_replace') !== 0) updateRecord(updateId);
    return;
  }
  if (mode === 'delete') {
    var created = createRecord();
    var createdId = extractRecordId(created);
    if (createdId) deleteRecord(createdId);
    return;
  }
  if (mode === 'cycle') {
    var res = createRecord();
    var id = extractRecordId(res);
    if (!id) return;
    updateRecord(id);
    deleteRecord(id);
    return;
  }
  if (mode === 'batch_update') {
    batchUpdate();
    return;
  }

  throw new Error('Unknown WRITE_MODE: ' + mode);
}
