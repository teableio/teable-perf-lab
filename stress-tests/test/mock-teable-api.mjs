// Minimal in-memory Teable API mock for tooling tests. Not a product emulator.
import http from 'node:http';

export function startMockTeable({ port = 18082 } = {}) {
  const tables = new Map();
  const records = new Map();
  const requests = [];
  let tableSeq = 0;
  let recordSeq = 0;

  function tableRecords(tableId) {
    if (!records.has(tableId)) records.set(tableId, new Map());
    return records.get(tableId);
  }

  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch {
          resolve(body);
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const body = await readBody(req);
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });
    const path = url.pathname;

    const tableCreate = path.match(/^\/api\/base\/([^/]+)\/table\/?$/);
    if (req.method === 'POST' && tableCreate) {
      const id = body?.id || `tbl_mock_${++tableSeq}`;
      const normalizedFields = (body?.fields || []).map((field, index) => ({
        ...field,
        id: field.id || `fld_mock_${index}`,
      }));
      const table = { id, name: body?.name || id, fields: normalizedFields };
      tables.set(id, table);
      records.set(id, new Map());
      return json(res, 201, table);
    }

    const tableGet = path.match(/^\/api\/table\/([^/]+)$/);
    if (req.method === 'GET' && tableGet) {
      const table = tables.get(tableGet[1]);
      return table ? json(res, 200, table) : json(res, 404, { error: 'table not found' });
    }

    const tableBaseGet = path.match(/^\/api\/base\/([^/]+)\/table\/([^/]+)$/);
    if (req.method === 'GET' && tableBaseGet) {
      const table = tables.get(tableBaseGet[2]);
      return table ? json(res, 200, table) : json(res, 404, { error: 'table not found' });
    }

    const fieldList = path.match(/^\/api\/table\/([^/]+)\/field$/);
    if (req.method === 'GET' && fieldList) {
      const table = tables.get(fieldList[1]);
      return json(res, 200, table?.fields || []);
    }
    if (req.method === 'POST' && fieldList) {
      const table = tables.get(fieldList[1]);
      if (!table) return json(res, 404, { error: 'table not found' });
      const field = { ...body, id: body?.id || `fld_mock_${table.fields.length + 1}` };
      table.fields.push(field);
      return json(res, 201, field);
    }


    const viewList = path.match(/^\/api\/table\/([^/]+)\/view$/);
    if (req.method === 'GET' && viewList) {
      return json(res, 200, [{ id: 'viw_mock', name: 'Grid view' }]);
    }

    const recordList = path.match(/^\/api\/table\/([^/]+)\/record$/);
    if (req.method === 'GET' && recordList) {
      const tableId = recordList[1];
      const filterRaw = url.searchParams.get('filter');
      let rows = [...tableRecords(tableId).entries()].map(([id, fields]) => ({ id, fields }));
      if (filterRaw) {
        try {
          const filter = JSON.parse(filterRaw);
          const item = (filter?.items || filter?.filterSet || [])[0];
          if (item?.fieldId && item?.value !== undefined) {
            const table = tables.get(tableId);
            const field = (table?.fields || []).find((f) => f.id === item.fieldId);
            const key = field?.name || item.fieldId;
            rows = rows.filter((row) => String(row.fields[key]) === String(item.value));
          }
        } catch {
          // ignore malformed filter in the mock
        }
      }
      return json(res, 200, { records: rows });
    }

    if (req.method === 'POST' && recordList) {
      const tableId = recordList[1];
      const created = [];
      for (const item of body?.records || []) {
        const id = `rec_mock_${++recordSeq}`;
        tableRecords(tableId).set(id, item.fields || {});
        created.push({ id, fields: item.fields || {} });
      }
      return json(res, 201, { records: created });
    }

    if (req.method === 'PATCH' && recordList) {
      const tableId = recordList[1];
      const updated = [];
      for (const item of body?.records || []) {
        const current = tableRecords(tableId).get(item.id) || {};
        const next = { ...current, ...(item.fields || {}) };
        tableRecords(tableId).set(item.id, next);
        updated.push({ id: item.id, fields: next });
      }
      return json(res, 200, { records: updated });
    }

    const recordOne = path.match(/^\/api\/table\/([^/]+)\/record\/([^/]+)$/);
    if (recordOne) {
      const tableId = recordOne[1];
      const recordId = recordOne[2];
      const current = tableRecords(tableId).get(recordId);
      if (!current) return json(res, 404, { error: 'record not found' });
      if (req.method === 'GET') return json(res, 200, { id: recordId, fields: current });
      if (req.method === 'PATCH') {
        const next = { ...current, ...(body?.record?.fields || body?.fields || {}) };
        tableRecords(tableId).set(recordId, next);
        return json(res, 200, { id: recordId, fields: next });
      }
      if (req.method === 'DELETE') {
        tableRecords(tableId).delete(recordId);
        return json(res, 200, { id: recordId });
      }
    }

    // v2 surface
    if (req.method === 'GET' && path === '/api/v2/tables/get') {
      const tableId = url.searchParams.get('tableId');
      const table = tables.get(tableId);
      return table ? json(res, 200, table) : json(res, 404, { error: 'table not found' });
    }
    if (req.method === 'GET' && path === '/api/v2/tables/listViews') {
      return json(res, 200, [{ id: 'viw_mock', name: 'Grid view' }]);
    }
    if (req.method === 'GET' && path === '/api/v2/tables/listRecords') {
      const tableId = url.searchParams.get('tableId');
      return json(res, 200, { records: [...tableRecords(tableId).entries()].map(([id, fields]) => ({ id, fields })) });
    }
    if (req.method === 'GET' && path === '/api/v2/tables/getRecord') {
      const tableId = url.searchParams.get('tableId');
      const recordId = url.searchParams.get('recordId');
      const fields = tableRecords(tableId).get(recordId);
      return fields ? json(res, 200, { id: recordId, fields }) : json(res, 404, { error: 'record not found' });
    }
    if (req.method === 'POST' && path === '/api/v2/tables/createRecord') {
      const tableId = body?.tableId;
      const id = `rec_mock_${++recordSeq}`;
      tableRecords(tableId).set(id, body?.fields || {});
      return json(res, 201, { id, fields: body?.fields || {} });
    }
    if (req.method === 'POST' && path === '/api/v2/tables/createRecords') {
      const tableId = body?.tableId;
      const created = [];
      for (const item of body?.records || []) {
        const id = `rec_mock_${++recordSeq}`;
        tableRecords(tableId).set(id, item.fields || {});
        created.push({ id, fields: item.fields || {} });
      }
      return json(res, 201, { records: created });
    }
    if (req.method === 'POST' && path === '/api/v2/tables/updateRecord') {
      const tableId = body?.tableId;
      const recordId = body?.recordId;
      const current = tableRecords(tableId).get(recordId) || {};
      const next = { ...current, ...(body?.fields || {}) };
      tableRecords(tableId).set(recordId, next);
      return json(res, 200, { id: recordId, fields: next });
    }
    if (req.method === 'POST' && path === '/api/v2/tables/updateRecords') {
      const tableId = body?.tableId;
      const updated = [];
      for (const item of body?.records || []) {
        const current = tableRecords(tableId).get(item.id) || {};
        const next = { ...current, ...(item.fields || {}) };
        tableRecords(tableId).set(item.id, next);
        updated.push({ id: item.id, fields: next });
      }
      return json(res, 200, { records: updated });
    }
    if (req.method === 'DELETE' && path === '/api/v2/tables/deleteRecords') {
      const tableId = body?.tableId;
      for (const id of body?.recordIds || []) tableRecords(tableId).delete(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/__mock/tables') {
      return json(res, 200, [...tables.keys()]);
    }
    if (req.method === 'GET' && path === '/__mock/requests') {
      return json(res, 200, requests);
    }

    return json(res, 404, { error: 'not found', path });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        server,
        requests,
        tables,
        records,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 18082);
  const mock = await startMockTeable({ port });
  console.log(`MOCK_TEABLE_LISTENING ${mock.port}`);
}
