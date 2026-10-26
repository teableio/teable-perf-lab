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

export var options = Object.assign({}, scenarioOptions(cfg, 'mixed'), {
  thresholds: {
    http_req_failed: ['rate<0.02'],
    dropped_iterations: ['count<100'],
    'teable_op_duration{op:list}': ['p(95)<1000', 'p(99)<3000'],
    'teable_op_duration{op:get}': ['p(95)<300', 'p(99)<1000'],
    'teable_op_duration{op:create}': ['p(95)<800', 'p(99)<2000'],
    'teable_op_duration{op:update}': ['p(95)<800', 'p(99)<2000'],
    'teable_op_duration{op:batch_update}': ['p(95)<60000', 'p(99)<120000'],
    'teable_op_duration{op:delete}': ['p(95)<800', 'p(99)<2000'],
  },
});

export var handleSummary = makeHandleSummary('summary-mixed.json');

function listUrl(probe) {
  var q = [];
  if (cfg.apiKind === 'v2') {
    q.push('tableId=' + encodeURIComponent(cfg.tableId));
    q.push('limit=' + cfg.take);
    q.push('fieldKeyType=name');
    if (cfg.viewId) q.push('viewId=' + encodeURIComponent(cfg.viewId));
    if (probe) q.push('search=' + encodeURIComponent(JSON.stringify([probe])));
    return cfg.baseUrl + '/api/v2/tables/listRecords?' + q.join('&');
  }
  q.push('take=' + cfg.take);
  if (cfg.viewId) q.push('viewId=' + encodeURIComponent(cfg.viewId));
  if (probe) q.push('search=' + encodeURIComponent(JSON.stringify([probe])));
  return cfg.baseUrl + '/api/table/' + encodeURIComponent(cfg.tableId) + '/record?' + q.join('&');
}

function getUrl(recordId) {
  if (cfg.apiKind === 'v2') {
    return (
      cfg.baseUrl +
      '/api/v2/tables/getRecord?tableId=' +
      encodeURIComponent(cfg.tableId) +
      '&recordId=' +
      encodeURIComponent(recordId)
    );
  }
  return (
    cfg.baseUrl +
    '/api/table/' +
    encodeURIComponent(cfg.tableId) +
    '/record/' +
    encodeURIComponent(recordId)
  );
}

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
  if (records.length === 0) return;

  if (cfg.apiKind === 'v2') {
    doRequest(
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
    return;
  }
  doRequest(
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

function pickWeighted() {
  var weights =
    cfg.mix === 'write'
      ? { list: 60, get: 5, create: 10, update: 15, batch_update: 8, delete: 2 }
      : { list: 80, get: 10, create: 3, update: 5, batch_update: 1.5, delete: 0.5 };
  var roll = Math.random() * 100;
  var acc = 0;
  var keys = Object.keys(weights);
  for (var i = 0; i < keys.length; i++) {
    acc += weights[keys[i]];
    if (roll <= acc) return keys[i];
  }
  return 'list';
}

export default function () {
  if (!hasRealIds()) {
    throw new Error('mixed scenario needs RECORD_IDS_FILE with real record IDs');
  }
  var op = pickWeighted();

  if (op === 'list') {
    doRequest(cfg, 'GET', listUrl(''), null, 'list', 200);
    return;
  }
  if (op === 'get') {
    var id = randomItem(ids);
    if (id && id.indexOf('rec_replace') !== 0) {
      doRequest(cfg, 'GET', getUrl(id), null, 'get', 200);
    } else {
      doRequest(cfg, 'GET', listUrl(''), null, 'list', 200);
    }
    return;
  }
  if (op === 'create') {
    createRecord();
    return;
  }
  if (op === 'update') {
    var updateId = randomItem(ids);
    if (updateId && updateId.indexOf('rec_replace') !== 0) updateRecord(updateId);
    return;
  }
  if (op === 'batch_update') {
    batchUpdate();
    return;
  }
  if (op === 'delete') {
    var created = createRecord();
    var createdId = extractRecordId(created);
    if (createdId) deleteRecord(createdId);
    return;
  }
}
