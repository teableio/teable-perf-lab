import { canonicalJson } from '../case/canonicalJson';
import { ReportCatalogueCoverageSchema, type TeaBenchReport } from './schema';

type Coverage = TeaBenchReport['catalogue'];
export type ReportSuiteReceipt = Coverage['suiteReceipts'][number];

const collectReceipts = (groups: ReadonlyArray<ReadonlyArray<ReportSuiteReceipt>>) => {
  const byId = new Map<string, ReportSuiteReceipt>();
  for (const receipt of groups.flat()) {
    const existing = byId.get(receipt.receiptId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error(`suite receipt 冲突：${receipt.receiptId}`);
    }
    byId.set(receipt.receiptId, receipt);
  }
  return [...byId.values()].sort((left, right) => left.receiptId.localeCompare(right.receiptId));
};

type GapKind = Coverage['gaps'][number]['kind'];

const gapKindOf = (receipt: ReportSuiteReceipt): GapKind | null => {
  if (!receipt.applicable) return 'not-applicable';
  if (receipt.execution === 'unsupported') return 'unsupported';
  if (receipt.execution === 'skipped') return 'skipped';
  if (!receipt.planned) return 'not-planned';
  if (receipt.execution === 'not-executed') return 'not-executed';
  return null;
};

const gapFor = (receipt: ReportSuiteReceipt): Coverage['gaps'][number] | null => {
  const kind = gapKindOf(receipt);
  if (kind === null) return null;
  return { scenarioId: receipt.scenarioId, kind, reason: receipt.reason ?? '未提供覆盖缺口原因' };
};

const countExecution = (receipts: ReadonlyArray<ReportSuiteReceipt>, execution: string) =>
  receipts.filter((receipt) => receipt.execution === execution).length;

/** 同一个 receiptId 可重复提交；内容冲突必须显式解决，不能静默覆盖。 */
export function mergeReportSuiteReceipts(
  groups: ReadonlyArray<ReadonlyArray<ReportSuiteReceipt>>
): Coverage {
  const suiteReceipts = collectReceipts(groups);
  return ReportCatalogueCoverageSchema.parse({
    requested: suiteReceipts.length,
    applicable: suiteReceipts.filter((receipt) => receipt.applicable).length,
    planned: suiteReceipts.filter((receipt) => receipt.planned).length,
    executed: countExecution(suiteReceipts, 'pass') + countExecution(suiteReceipts, 'fail'),
    pass: countExecution(suiteReceipts, 'pass'),
    fail: countExecution(suiteReceipts, 'fail'),
    skipped: countExecution(suiteReceipts, 'skipped'),
    unsupported: countExecution(suiteReceipts, 'unsupported'),
    suiteReceipts,
    gaps: suiteReceipts.flatMap((receipt) => {
      const gap = gapFor(receipt);
      return gap === null ? [] : [gap];
    }),
  });
}
