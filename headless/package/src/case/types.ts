import type { ComplexityAssessment, SchemaComplexityProfile } from '@teable/v2-complexity';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';

import type { BenchCaseManifest } from './manifest';

export type ResolvedField = {
  readonly id: string;
  readonly declaredId?: string;
  readonly name: string;
  readonly type: string;
  readonly isComputed: boolean;
  readonly isPrimary: boolean;
  readonly isMultiple: boolean;
  readonly choices?: ReadonlyArray<string>;
  readonly ratingMax?: number;
  readonly link?: { readonly table: string; readonly relationship: string };
};

export type ResolvedTable = {
  readonly id: string;
  readonly name: string;
  readonly declaredId?: string;
  readonly primaryFieldName: string;
  readonly fields: ReadonlyMap<string, ResolvedField>;
  readonly views?: ReadonlyMap<
    string,
    { readonly id: string; readonly name: string; readonly declaredId?: string }
  >;
};

export type LoadedCase = {
  readonly manifest: BenchCaseManifest;
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly environment: { readonly pgVersion?: string };
  readonly tables: ReadonlyMap<string, ResolvedTable>;
  readonly recordsByTable: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly id: string; readonly primary: unknown }>
  >;
  readonly complexity: {
    readonly profile: SchemaComplexityProfile;
    readonly assessments: Readonly<Record<string, ComplexityAssessment>>;
    readonly warnings: ReadonlyArray<string>;
  };
  readonly setup: {
    readonly importMs: number;
    readonly resolveMs: number;
    readonly seedMs: number;
    readonly flushMs: number;
    readonly totalRows: number;
  };
  close(): Promise<void>;
};
