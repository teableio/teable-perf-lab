import { createHash } from 'node:crypto';

const domains = new Set(['crm', 'ecommerce', 'project', 'hr']);
const anchor = Date.UTC(2026, 9, 1);
const notes = [
  'Customer requested a phased rollout after the security review.',
  'Renewal and procurement follow-up scheduled for next quarter.',
  '客户希望增加中文界面与批量导出。',
  '需要复核权限、关联关系和最终计算结果。',
  '本周重点 🚀；交付风险 ⚠️，等待负责人确认。',
];

export async function buildBusinessProfile(options) {
  const domain = options.domain ?? 'crm';
  if (!domains.has(domain)) throw new Error(`Unknown --domain: ${domain}; choose crm, ecommerce, project, hr`);
  const seed = Number(options.seed ?? 42);
  const scale = Number(options.scale ?? 1);
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a safe integer');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('--scale must be positive');

  const counts = {};
  const helpers = {
    count(name, fallback, { min = 1, scaled = false } = {}) {
      const raw = Number(options[name] ?? fallback);
      if (!Number.isSafeInteger(raw) || raw < min) {
        throw new Error(`--${name} must be an integer >= ${min}`);
      }
      const value = scaled ? Math.max(min, Math.round(raw * scale)) : raw;
      if (!Number.isSafeInteger(value)) throw new Error(`--${name} is too large`);
      counts[name] = value;
      return value;
    },
    rng(index, salt = 0) {
      let state = (seed ^ Math.imul(index + 1, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    },
    pick(random, values) { return values[Math.floor(random() * values.length)]; },
    money(value) { return Math.round(value * 100) / 100; },
    date(days) { return new Date(anchor + days * 86400000).toISOString(); },
    note(random) { return random() < 0.1 ? '' : notes[Math.floor(random() * notes.length)]; },
    text(name) { return { name, type: 'singleLineText' }; },
    number(name) { return { name, type: 'number' }; },
    dateField(name) { return { name, type: 'date' }; },
    select(name, choices) { return { name, type: 'singleSelect', options: { choices: choices.map((choice) => ({ name: choice })) } }; },
    multiSelect(name, choices) { return { name, type: 'multipleSelect', options: { choices: choices.map((choice) => ({ name: choice })) } }; },
    checkbox(name) { return { name, type: 'checkbox' }; },
    linkField(name, target, { many = false } = {}) { return { name, type: 'link', target, many }; },
    formula(name, expression) { return { name, type: 'formula', expression }; },
  };
  const { default: createProfile } = await import(`../datasets/business/${domain}.mjs`);
  const profile = createProfile(options, helpers);
  const knownTables = new Map();
  let totalRows = 0;
  for (const table of profile.tables) {
    if (knownTables.has(table.key)) throw new Error(`Duplicate table: ${table.key}`);
    if (!Number.isSafeInteger(table.count) || table.count < 0) throw new Error(`Invalid count: ${table.key}`);
    const fields = new Set();
    for (const field of table.fields) {
      if (fields.has(field.name)) throw new Error(`Duplicate field: ${table.key}.${field.name}`);
      if (field.type === 'link' && !knownTables.has(field.target)) {
        throw new Error(`Link ${table.key}.${field.name} must target an earlier table`);
      }
      if (field.type === 'formula') {
        for (const match of field.expression.matchAll(/\{([^}]+)\}/g)) {
          if (!fields.has(match[1])) throw new Error(`Unknown formula reference: ${table.key}.${match[1]}`);
        }
      }
      fields.add(field.name);
    }
    knownTables.set(table.key, table);
    totalRows += table.count;
    if (!Number.isSafeInteger(totalRows)) throw new Error('Dataset row count is too large');
  }
  if (!knownTables.has(profile.primary)) throw new Error('Invalid primary table');
  for (const workload of profile.workloads) {
    const field = knownTables.get(workload.table)?.fields.find((item) => item.name === workload.field);
    if (!field || !['singleLineText', 'longText'].includes(field.type)) {
      throw new Error(`Workload needs an editable text field: ${workload.table}.${workload.field}`);
    }
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ domain, seed, counts, schema: profile.tables.map(({ key, count, fields }) => ({ key, count, fields })), computed: !options['no-computed'] }))
    .digest('hex').slice(0, 12);
  return { ...profile, seed, counts, totalRows, datasetId: options['dataset-id'] ?? `ds_${domain}_${fingerprint}_v1` };
}

export function logicalContext(profile) {
  const tables = new Map(profile.tables.map((table) => [table.key, table]));
  return {
    link(target, index) {
      const table = tables.get(target);
      if (!table || !Number.isInteger(index) || index < 0 || index >= table.count) {
        throw new Error(`Invalid link target ${target}[${index}]`);
      }
      return { id: `${target}:${index}` };
    },
  };
}
