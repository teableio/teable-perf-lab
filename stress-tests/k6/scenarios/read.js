import { SharedArray } from 'k6/data';
import { loadConfig, scenarioOptions } from '../lib/config.js';
import { doRequest, randomItem } from '../lib/http.js';
import { makeHandleSummary } from '../lib/summary.js';

var cfg = loadConfig();

var ids = new SharedArray('record_ids', function () {
  return JSON.parse(open(cfg.recordIdsFile));
});

export var options = Object.assign({}, scenarioOptions(cfg, 'read'), {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    dropped_iterations: ['count<100'],
    'teable_op_duration{op:list}': ['p(95)<1000', 'p(99)<3000'],
    'teable_op_duration{op:get}': ['p(95)<300', 'p(99)<1000'],
    'teable_op_duration{op:search}': ['p(95)<1000', 'p(99)<3000'],
  },
});

export var handleSummary = makeHandleSummary('summary-read.json');

function projectionList() {
  if (!cfg.projection) return [];
  return cfg.projection
    .split(',')
    .map(function (value) {
      return value.trim();
    })
    .filter(function (value) {
      return value.length > 0;
    });
}

function listUrl(probe) {
  var q = [];
  var projections = projectionList();

  if (cfg.apiKind === 'v2') {
    q.push('tableId=' + encodeURIComponent(cfg.tableId));
    q.push('limit=' + cfg.take);
    q.push('fieldKeyType=name');
    if (cfg.viewId) q.push('viewId=' + encodeURIComponent(cfg.viewId));
    if (cfg.filterJson) q.push('filter=' + encodeURIComponent(cfg.filterJson));
    if (cfg.sortJson) q.push('sort=' + encodeURIComponent(cfg.sortJson));
    if (cfg.groupJson) q.push('groupBy=' + encodeURIComponent(cfg.groupJson));
    if (projections.length) {
      q.push('projection=' + encodeURIComponent(JSON.stringify(projections)));
    }
    if (cfg.includeTotal) q.push('includeTotal=true');
    if (cfg.pageMode === 'cursor' && cfg.cursor) {
      q.push('cursor=' + encodeURIComponent(cfg.cursor));
    } else if (cfg.skip > 0) {
      q.push('offset=' + cfg.skip);
    }
    if (probe) q.push('search=' + encodeURIComponent(JSON.stringify([probe])));
    return cfg.baseUrl + '/api/v2/tables/listRecords?' + q.join('&');
  }

  q.push('take=' + cfg.take);
  if (cfg.viewId) q.push('viewId=' + encodeURIComponent(cfg.viewId));
  if (cfg.filterJson) q.push('filter=' + encodeURIComponent(cfg.filterJson));
  if (cfg.sortJson) q.push('orderBy=' + encodeURIComponent(cfg.sortJson));
  if (cfg.groupJson) q.push('groupBy=' + encodeURIComponent(cfg.groupJson));
  if (cfg.includeTotal) q.push('includeTotal=true');
  projections.forEach(function (field) {
    q.push('projection=' + encodeURIComponent(field));
  });
  if (cfg.pageMode === 'cursor' && cfg.cursor) {
    q.push('cursor=' + encodeURIComponent(cfg.cursor));
  } else if (cfg.skip > 0) {
    q.push('skip=' + cfg.skip);
  }
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

function doList(probe) {
  return doRequest(cfg, 'GET', listUrl(probe), null, probe ? 'search' : 'list', 200);
}

function doGet() {
  var recordId = randomItem(ids);
  if (!recordId || recordId.indexOf('rec_replace') === 0) {
    return doList('');
  }
  return doRequest(cfg, 'GET', getUrl(recordId), null, 'get', 200);
}

export default function () {
  var mode = cfg.readMode;

  if (mode === 'list') {
    doList('');
    return;
  }
  if (mode === 'get') {
    doGet();
    return;
  }
  if (mode === 'search') {
    doList(cfg.searchProbe);
    return;
  }

  if (Math.random() < 0.8) {
    doList('');
  } else {
    doGet();
  }
}
