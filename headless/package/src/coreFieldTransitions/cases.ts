import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreFieldTransitionsBenchCase = {
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

export const CORE_FIELD_TRANSITIONS_CASES = [
  {
    key: 'core:UpdateFieldCommand/text-to-number-mixed-64',
    identity: 'UpdateFieldCommand(singleLineText→number,mixed-64)',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/text-to-number-mixed-64',
    identity: 'IHeadlessRuntime.flushComputed(text→number dependents)',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateFieldCommand/number-to-text-formatted-64',
    identity: 'UpdateFieldCommand(number→singleLineText,decimal-2,64)',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/number-to-text-formatted-64',
    identity: 'IHeadlessRuntime.flushComputed(number→text dependents)',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateFieldCommand/dependent-formula-expression-64',
    identity: 'UpdateFieldCommand(dependent formula expression,64)',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/dependent-formula-expression-64',
    identity: 'IHeadlessRuntime.flushComputed(formula chain,64)',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateFieldCommand/reject-nonstring-formula-expression',
    identity: 'UpdateFieldCommand(non-string formula expression,expected validation error)',
    kind: 'write-update',
  },
] as const satisfies ReadonlyArray<CoreFieldTransitionsBenchCase>;

export type CoreFieldTransitionsBenchCaseKey = (typeof CORE_FIELD_TRANSITIONS_CASES)[number]['key'];
