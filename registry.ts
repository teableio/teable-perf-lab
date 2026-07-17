import authUserCase from "./cases/smoke/auth-user.case";
import formula10kCalcCase from "./cases/formula/10k-calc.case";
import formula10k5ConcurrentCase from "./cases/formula/10k-5-concurrent.case";
import formula50kCalcCase from "./cases/formula/50k-calc.case";
import conditionalLookup10kCase from "./cases/lookup/conditional-10k.case";
import conditionalRollup10kCase from "./cases/rollup/conditional-10k.case";
import conditionalLookupGroupActiveText10kCase from "./cases/lookup/conditional-group-active-text-10k.case";
import conditionalLookupGroupActiveTextFanout50_10kCase from "./cases/lookup/conditional-group-active-text-fanout50-10k.case";
import conditionalLookupGroupActiveTextFanout100_10kCase from "./cases/lookup/conditional-group-active-text-fanout100-10k.case";
import conditionalLookupGroupActiveFlip1kFanout100_10kCase from "./cases/lookup/conditional-group-active-flip-1k-fanout100-10k.case";
import conditionalLookupGroupActiveFlip1kFanout100_30kCase from "./cases/lookup/conditional-group-active-flip-1k-fanout100-30k.case";
import conditionalLookupGroupNumberTop3_10kCase from "./cases/lookup/conditional-group-number-top3-10k.case";
import conditionalLookupGroupNumberTop3Fanout50_10kCase from "./cases/lookup/conditional-group-number-top3-fanout50-10k.case";
import conditionalLookupGroupNumberTop3Fanout100_10kCase from "./cases/lookup/conditional-group-number-top3-fanout100-10k.case";
import conditionalLookupGroupTextFanout10_10kCase from "./cases/lookup/conditional-group-text-fanout10-10k.case";
import conditionalLookupGroupTextFanout50_10kCase from "./cases/lookup/conditional-group-text-fanout50-10k.case";
import conditionalLookupGroupTextFanout100_10kCase from "./cases/lookup/conditional-group-text-fanout100-10k.case";
import conditionalLookupGroupTextUpdate1kFanout10_10kCase from "./cases/lookup/conditional-group-text-update-1k-fanout10-10k.case";
import conditionalLookupGroupTextUpdate1kFanout50_10kCase from "./cases/lookup/conditional-group-text-update-1k-fanout50-10k.case";
import conditionalLookupGroupTextUpdate1kFanout100_10kCase from "./cases/lookup/conditional-group-text-update-1k-fanout100-10k.case";
import conditionalLookupGroupTextUpdate1kFanout100Limit10_10kCase from "./cases/lookup/conditional-group-text-update-1k-fanout100-limit10-10k.case";
import conditionalLookupGroupTextUpdate1kFanout100Limit50_10kCase from "./cases/lookup/conditional-group-text-update-1k-fanout100-limit50-10k.case";
import conditionalLookupGroupTextUpdate1kFanout100_20kCase from "./cases/lookup/conditional-group-text-update-1k-fanout100-20k.case";
import conditionalLookupGroupTextUpdate1kFanout100_30kCase from "./cases/lookup/conditional-group-text-update-1k-fanout100-30k.case";
import conditionalRollupGroupActiveMax10kCase from "./cases/rollup/conditional-group-active-max-10k.case";
import conditionalRollupGroupActiveSumFanout10_10kCase from "./cases/rollup/conditional-group-active-sum-fanout10-10k.case";
import conditionalRollupGroupActiveSumFanout50_10kCase from "./cases/rollup/conditional-group-active-sum-fanout50-10k.case";
import conditionalRollupGroupActiveSumFanout100_10kCase from "./cases/rollup/conditional-group-active-sum-fanout100-10k.case";
import conditionalRollupGroupActiveSumUpdate1kFanout10_10kCase from "./cases/rollup/conditional-group-active-sum-update-1k-fanout10-10k.case";
import conditionalRollupGroupActiveSumUpdate1kFanout50_10kCase from "./cases/rollup/conditional-group-active-sum-update-1k-fanout50-10k.case";
import conditionalRollupGroupActiveSumUpdate1kFanout100_10kCase from "./cases/rollup/conditional-group-active-sum-update-1k-fanout100-10k.case";
import conditionalRollupGroupActiveSumUpdate1kFanout100_20kCase from "./cases/rollup/conditional-group-active-sum-update-1k-fanout100-20k.case";
import conditionalRollupGroupActiveSumUpdate1kFanout100_30kCase from "./cases/rollup/conditional-group-active-sum-update-1k-fanout100-30k.case";
import conditionalRollupGroupAverageFanout10_10kCase from "./cases/rollup/conditional-group-average-fanout10-10k.case";
import conditionalRollupGroupCountallFanout10_10kCase from "./cases/rollup/conditional-group-countall-fanout10-10k.case";
import conditionalRollupGroupSumFanout10_10kCase from "./cases/rollup/conditional-group-sum-fanout10-10k.case";
import conditionalRollupGroupTextTop3_10kCase from "./cases/rollup/conditional-group-text-top3-10k.case";
import dualLinkComputedFirstLink4kCase from "./cases/lookup/dual-link-computed-first-link-4k.case";
import dualLinkComputedFirstLink1of4kGetRecordCase from "./cases/lookup/dual-link-computed-first-link-1of4k-get-record.case";
import dualLinkComputedFirstLink1of4kGetRecordsCase from "./cases/lookup/dual-link-computed-first-link-1of4k-get-records.case";
import dualLinkComputedRepoint2kCase from "./cases/lookup/dual-link-computed-repoint-2k.case";
import foreignSelectFlip1of40Fanout100_4kCase from "./cases/lookup/foreign-select-flip-1of40-fanout100-4k.case";
import foreignFirstNameUpdate1of40Fanout100_4kCase from "./cases/lookup/foreign-first-name-update-1of40-fanout100-4k.case";
import customerUpdateUserCreateOrder4kDepth5Case from "./cases/lookup/customer-update-user-create-order-4k-depth5.case";
import customerUpdateUserUpdateOrder4kDepth5Case from "./cases/lookup/customer-update-user-update-order-4k-depth5.case";
import customerCreateUserCreateOrder4kDepth5Case from "./cases/lookup/customer-create-user-create-order-4k-depth5.case";
import customerCreateOrderOnly4kDepth5Case from "./cases/lookup/customer-create-order-only-4k-depth5.case";
import customerUpdateUserFirstNameOnlyCreateOrder4kDepth5Case from "./cases/lookup/customer-update-user-first-name-only-create-order-4k-depth5.case";
import customerUpdateUserControlFieldCreateOrder4kDepth5Case from "./cases/lookup/customer-update-user-control-field-create-order-4k-depth5.case";
import customerUpdateOtherUserCreateOrder4kDepth5Case from "./cases/lookup/customer-update-other-user-create-order-4k-depth5.case";
import searchIndexOff10k20SearchFieldsCase from "./cases/search/search-index-off-10k-20search-fields.case";
import searchIndexOff50k20SearchFieldsCase from "./cases/search/search-index-off-50k-20search-fields.case";
import searchIndexOn10k20SearchFieldsCase from "./cases/search/search-index-on-10k-20search-fields.case";
import searchIndexOn50k20SearchFieldsCase from "./cases/search/search-index-on-50k-20search-fields.case";
import fieldCreateFormula10kCreate5FieldsCase from "./cases/field-create/10k-create-5-formula-fields.case";
import fieldCreateMixed10kCreate19FieldsCase from "./cases/field-create/mixed-10k-create-19-fields.case";
import fieldCreateSimple10kCreate5FieldsCase from "./cases/field-create/10k-create-5-simple-fields.case";
import fieldCreateSingleSelect1kOptionsCase from "./cases/field-create/single-select-1k-options.case";
import fieldConvert10kMultiSelectToTextCase from "./cases/field-convert/10k-multi-select-to-text.case";
import fieldConvert10kSingleSelectToTextCase from "./cases/field-convert/10k-single-select-to-text.case";
import fieldConvert10kNumberToTextCase from "./cases/field-convert/10k-number-to-text.case";
import fieldConvert10kCheckboxToTextCase from "./cases/field-convert/10k-checkbox-to-text.case";
import fieldConvert10kRatingToTextCase from "./cases/field-convert/10k-rating-to-text.case";
import fieldConvert10kLongTextToTextCase from "./cases/field-convert/10k-long-text-to-text.case";
import fieldConvert10kTextToNumberMixedCase from "./cases/field-convert/10k-text-to-number-mixed.case";
import fieldConvert10kTextToSingleSelectCase from "./cases/field-convert/10k-text-to-single-select.case";
import fieldConvert10kTextToMultipleSelectCase from "./cases/field-convert/10k-text-to-multiple-select.case";
import fieldConvert10kTextToCheckboxMixedCase from "./cases/field-convert/10k-text-to-checkbox-mixed.case";
import fieldConvert10kTextToDateMixedCase from "./cases/field-convert/10k-text-to-date-mixed.case";
import fieldConvert10kTextToAttachmentClearCase from "./cases/field-convert/10k-text-to-attachment-clear.case";
import fieldConvert10kTextToAutoNumberCase from "./cases/field-convert/10k-text-to-auto-number.case";
import fieldConvert10kNumberToRatingClampedCase from "./cases/field-convert/10k-number-to-rating-clamped.case";
import fieldConvert10kSingleSelectChoicePruneCase from "./cases/field-convert/10k-single-select-choice-prune.case";
import fieldConvert10kMultipleSelectChoicePruneCase from "./cases/field-convert/10k-multiple-select-choice-prune.case";
import fieldConvert10kTextToFormulaCase from "./cases/field-convert/10k-text-to-formula.case";
import fieldConvert10kLinkToTextCase from "./cases/field-convert/10k-link-to-text.case";
import fieldConvert10kTextToLinkCase from "./cases/field-convert/10k-text-to-link.case";
import formulaExpressionUpdate4kDepth5CascadeCase from "./cases/field-convert/formula-expression-update-4k-depth5-cascade.case";
import formulaDependencyAdd4kDepth5CascadeCase from "./cases/field-convert/formula-dependency-add-4k-depth5-cascade.case";
import formulaDependencyReplace4kDepth5CascadeCase from "./cases/field-convert/formula-dependency-replace-4k-depth5-cascade.case";
import formulaDependencyRemove4kDepth5CascadeCase from "./cases/field-convert/formula-dependency-remove-4k-depth5-cascade.case";
import fieldDeleteMixed10kDelete19FieldsCase from "./cases/field-delete/mixed-10k-delete-19-fields.case";
import fieldRestore10kDescriptionFieldCase from "./cases/field-restore/10k-description-field.case";
import fieldRestore10kStatusFieldCase from "./cases/field-restore/10k-status-field.case";
import fieldRestore10kStartDateFieldCase from "./cases/field-restore/10k-start-date-field.case";
import fieldRestore10kOwnerTextFieldCase from "./cases/field-restore/10k-owner-text-field.case";
import fieldRestore10kTagsFieldCase from "./cases/field-restore/10k-tags-field.case";
import fieldRestore10kAmountFieldCase from "./cases/field-restore/10k-amount-field.case";
import fieldRestore10kActiveFieldCase from "./cases/field-restore/10k-active-field.case";
import fieldRestore10kScoreFieldCase from "./cases/field-restore/10k-score-field.case";
import fieldDuplicateConditionalLookup10kCase from "./cases/field-duplicate/conditional-lookup-10k.case";
import fieldUpdate10kSelectOptionRenameComputedCascadeCase from "./cases/field-update/v2-only-10k-select-option-rename-computed-cascade.case";
import duplicateTable10k20FCase from "./cases/duplicate-table/10k-20f.case";
import duplicateTable10k25F5FormulaCase from "./cases/duplicate-table/10k-25f-5formula.case";
import duplicateTable10k20FSelflinkCase from "./cases/duplicate-table/10k-20f-selflink.case";
import duplicateViewComplexGrid20FieldsP95Case from "./cases/duplicate-view/complex-grid-20fields-p95.case";
import duplicateBase10k3TablesLink2WorkflowCase from "./cases/duplicate-base/10k-3tables-link-2workflow.case";
import duplicateBase10k3TablesLink2WorkflowStreamCase from "./cases/duplicate-base/10k-3tables-link-2workflow-stream.case";
import importBaseV2OnlySimple1x1kTableStreamCase from "./cases/import-base/v2-only-simple-1x1k-table-stream.case";
import importBaseV2OnlySimple1x10kTableStreamCase from "./cases/import-base/v2-only-simple-1x10k-table-stream.case";
import importBaseV2OnlyComplex3x10k3Tables2WorkflowStreamCase from "./cases/import-base/v2-only-complex-3x10k-3tables-2workflow-stream.case";
import importBaseV2OnlyUserT2377TeaStreamCase from "./cases/import-base/v2-only-user-t2377-tea-stream.case";
import exportBase10k3TablesLink2WorkflowStreamCase from "./cases/export-base/10k-3tables-link-2workflow-stream.case";
import tableCreate10x20FNoRecordsCase from "./cases/table-create/10x-20f-no-records.case";
import tableCreate1x20F1kRecordsCase from "./cases/table-create/1x-20f-1k-records.case";
import tableCreate1x20F5kRecordsCase from "./cases/table-create/1x-20f-5k-records.case";
import tableDelete10k20FCase from "./cases/table-delete/10k-20f.case";
import tableDelete10k20FLinkDetachCase from "./cases/table-delete/10k-20f-link-detach.case";
import tableDelete30k20FLinkDetachCase from "./cases/table-delete/30k-20f-link-detach.case";
import tableRestore10k20FCase from "./cases/table-restore/10k-20f.case";
import tableRestore10k20FLink1kCase from "./cases/table-restore/10k-20f-link-1k.case";
import csvImportMixed1k20FieldsCreateTableImportCase from "./cases/csv-import/mixed-1k-20fields-create-table-import.case";
import csvImportMixed10k20FieldsCreateTableImportCase from "./cases/csv-import/mixed-10k-20fields-create-table-import.case";
import csvImportMixed10k20FieldsInplaceImportCase from "./cases/csv-import/mixed-10k-20fields-inplace-import.case";
import formSubmitSequential200Case from "./cases/form-submit/sequential-200.case";
import recordCreateMixed1k20FieldsBulkCreateCase from "./cases/record-create/mixed-1k-20fields-bulk-create.case";
import recordDuplicateGridBlockDuplicate1kCase from "./cases/record-duplicate/grid-block-duplicate-1k.case";
import recordDuplicateSingleRecordSequential100Case from "./cases/record-duplicate/single-record-sequential-100.case";
import recordRead10k50Fields10x1kPagesCase from "./cases/record-read/10k-50fields-10x1k-pages.case";
import recordRead10k50FieldsFilterSortGroupbyOverheadCase from "./cases/record-read/10k-50fields-filter-sort-groupby-overhead.case";
import recordRead50k50Fields50x1kPagesCase from "./cases/record-read/50k-50fields-50x1k-pages.case";
import recordPasteFlat10k20FieldsCopyPasteCase from "./cases/record-paste/flat-10k-20fields-copy-paste.case";
import recordPasteFlat10k4FieldsCopyPasteCase from "./cases/record-paste/flat-10k-4fields-copy-paste.case";
import recordPasteMixed10k20FieldsComplexCopyPasteCase from "./cases/record-paste/mixed-10k-20fields-complex-copy-paste.case";
import selectionPaste10kExpandRowsAndFieldsStreamCase from "./cases/selection-paste/10k-expand-rows-and-fields-stream.case";
import recordReorder10kMoveLast1kToFrontCase from "./cases/record-reorder/10k-move-last-1k-to-front.case";
import recordUpdateMixed1k20FieldsBulkUpdateCase from "./cases/record-update/mixed-1k-20fields-bulk-update.case";
import recordUpdateAttachmentInsert100Case from "./cases/record-update/attachment-insert-100.case";
import recordUpdateAttachmentInsert1kCase from "./cases/record-update/attachment-insert-1k.case";
import recordUpdate1kLinkCellsBulkUpdateCase from "./cases/record-update/1k-link-cells-bulk-update.case";
import recordUpdateSingleForeignFirstNameFanout100_4kCase from "./cases/record-update/single-foreign-first-name-update-1of40-fanout100-4k.case";
import recordUpdateSingleForeignSelectFanout100_4kCase from "./cases/record-update/single-foreign-select-update-1of40-fanout100-4k.case";
import selectionClearFlat1k20FieldsCellClearStreamCase from "./cases/selection-clear/flat-1k-20fields-cell-clear-stream.case";
import selectionClearFlat10k20FieldsCellClearStreamCase from "./cases/selection-clear/flat-10k-20fields-cell-clear-stream.case";
import recordDelete1kCase from "./cases/record-delete/delete-1k.case";
import recordDeleteStream1kCase from "./cases/record-delete/delete-stream-1k.case";
import recordDeleteStream10kCase from "./cases/record-delete/delete-stream-10k.case";
import recordDeleteStream30kCase from "./cases/record-delete/delete-stream-30k.case";
import recordDeleteLinkTrash1kCase from "./cases/record-delete/link-trash-1k.case";
import recordRedoDelete1kCase from "./cases/record-redo/delete-1k.case";
import recordUndoDelete1kCase from "./cases/record-undo/delete-1k.case";
import type { PerfCase } from "./framework/types";

const cases = [
  authUserCase,
  formula10kCalcCase,
  formula10k5ConcurrentCase,
  formula50kCalcCase,
  conditionalLookup10kCase,
  conditionalRollup10kCase,
  conditionalLookupGroupTextFanout10_10kCase,
  conditionalLookupGroupTextFanout50_10kCase,
  conditionalLookupGroupTextFanout100_10kCase,
  conditionalLookupGroupTextUpdate1kFanout10_10kCase,
  conditionalLookupGroupTextUpdate1kFanout50_10kCase,
  conditionalLookupGroupTextUpdate1kFanout100_10kCase,
  conditionalLookupGroupTextUpdate1kFanout100Limit10_10kCase,
  conditionalLookupGroupTextUpdate1kFanout100Limit50_10kCase,
  conditionalLookupGroupTextUpdate1kFanout100_20kCase,
  conditionalLookupGroupTextUpdate1kFanout100_30kCase,
  conditionalLookupGroupNumberTop3_10kCase,
  conditionalLookupGroupNumberTop3Fanout50_10kCase,
  conditionalLookupGroupNumberTop3Fanout100_10kCase,
  conditionalLookupGroupActiveText10kCase,
  conditionalLookupGroupActiveTextFanout50_10kCase,
  conditionalLookupGroupActiveTextFanout100_10kCase,
  conditionalLookupGroupActiveFlip1kFanout100_10kCase,
  conditionalLookupGroupActiveFlip1kFanout100_30kCase,
  conditionalRollupGroupCountallFanout10_10kCase,
  conditionalRollupGroupSumFanout10_10kCase,
  conditionalRollupGroupAverageFanout10_10kCase,
  conditionalRollupGroupActiveMax10kCase,
  conditionalRollupGroupActiveSumFanout10_10kCase,
  conditionalRollupGroupActiveSumFanout50_10kCase,
  conditionalRollupGroupActiveSumFanout100_10kCase,
  conditionalRollupGroupActiveSumUpdate1kFanout10_10kCase,
  conditionalRollupGroupActiveSumUpdate1kFanout50_10kCase,
  conditionalRollupGroupActiveSumUpdate1kFanout100_10kCase,
  conditionalRollupGroupActiveSumUpdate1kFanout100_20kCase,
  conditionalRollupGroupActiveSumUpdate1kFanout100_30kCase,
  conditionalRollupGroupTextTop3_10kCase,
  dualLinkComputedFirstLink4kCase,
  dualLinkComputedFirstLink1of4kGetRecordCase,
  dualLinkComputedFirstLink1of4kGetRecordsCase,
  dualLinkComputedRepoint2kCase,
  foreignSelectFlip1of40Fanout100_4kCase,
  foreignFirstNameUpdate1of40Fanout100_4kCase,
  customerUpdateUserCreateOrder4kDepth5Case,
  customerUpdateUserUpdateOrder4kDepth5Case,
  customerCreateUserCreateOrder4kDepth5Case,
  customerCreateOrderOnly4kDepth5Case,
  customerUpdateUserFirstNameOnlyCreateOrder4kDepth5Case,
  customerUpdateUserControlFieldCreateOrder4kDepth5Case,
  customerUpdateOtherUserCreateOrder4kDepth5Case,
  searchIndexOff10k20SearchFieldsCase,
  searchIndexOn10k20SearchFieldsCase,
  searchIndexOff50k20SearchFieldsCase,
  searchIndexOn50k20SearchFieldsCase,
  fieldCreateSimple10kCreate5FieldsCase,
  fieldCreateFormula10kCreate5FieldsCase,
  fieldCreateMixed10kCreate19FieldsCase,
  fieldCreateSingleSelect1kOptionsCase,
  fieldConvert10kMultiSelectToTextCase,
  fieldConvert10kSingleSelectToTextCase,
  fieldConvert10kNumberToTextCase,
  fieldConvert10kCheckboxToTextCase,
  fieldConvert10kRatingToTextCase,
  fieldConvert10kLongTextToTextCase,
  fieldConvert10kTextToNumberMixedCase,
  fieldConvert10kTextToSingleSelectCase,
  fieldConvert10kTextToMultipleSelectCase,
  fieldConvert10kTextToCheckboxMixedCase,
  fieldConvert10kTextToDateMixedCase,
  fieldConvert10kTextToAttachmentClearCase,
  fieldConvert10kTextToAutoNumberCase,
  fieldConvert10kNumberToRatingClampedCase,
  fieldConvert10kSingleSelectChoicePruneCase,
  fieldConvert10kMultipleSelectChoicePruneCase,
  fieldConvert10kTextToFormulaCase,
  fieldConvert10kLinkToTextCase,
  fieldConvert10kTextToLinkCase,
  formulaExpressionUpdate4kDepth5CascadeCase,
  formulaDependencyAdd4kDepth5CascadeCase,
  formulaDependencyReplace4kDepth5CascadeCase,
  formulaDependencyRemove4kDepth5CascadeCase,
  fieldUpdate10kSelectOptionRenameComputedCascadeCase,
  fieldDeleteMixed10kDelete19FieldsCase,
  fieldRestore10kDescriptionFieldCase,
  fieldRestore10kStatusFieldCase,
  fieldRestore10kStartDateFieldCase,
  fieldRestore10kOwnerTextFieldCase,
  fieldRestore10kTagsFieldCase,
  fieldRestore10kAmountFieldCase,
  fieldRestore10kActiveFieldCase,
  fieldRestore10kScoreFieldCase,
  fieldDuplicateConditionalLookup10kCase,
  duplicateTable10k20FCase,
  duplicateTable10k25F5FormulaCase,
  duplicateTable10k20FSelflinkCase,
  duplicateViewComplexGrid20FieldsP95Case,
  duplicateBase10k3TablesLink2WorkflowCase,
  duplicateBase10k3TablesLink2WorkflowStreamCase,
  importBaseV2OnlySimple1x1kTableStreamCase,
  importBaseV2OnlySimple1x10kTableStreamCase,
  importBaseV2OnlyComplex3x10k3Tables2WorkflowStreamCase,
  importBaseV2OnlyUserT2377TeaStreamCase,
  exportBase10k3TablesLink2WorkflowStreamCase,
  tableCreate10x20FNoRecordsCase,
  tableCreate1x20F1kRecordsCase,
  tableCreate1x20F5kRecordsCase,
  tableDelete10k20FCase,
  tableDelete10k20FLinkDetachCase,
  tableDelete30k20FLinkDetachCase,
  tableRestore10k20FCase,
  tableRestore10k20FLink1kCase,
  csvImportMixed1k20FieldsCreateTableImportCase,
  csvImportMixed10k20FieldsCreateTableImportCase,
  csvImportMixed10k20FieldsInplaceImportCase,
  formSubmitSequential200Case,
  selectionClearFlat1k20FieldsCellClearStreamCase,
  selectionClearFlat10k20FieldsCellClearStreamCase,
  recordDelete1kCase,
  recordDeleteStream1kCase,
  recordDeleteStream10kCase,
  recordDeleteStream30kCase,
  recordDeleteLinkTrash1kCase,
  recordRead10k50Fields10x1kPagesCase,
  recordRead10k50FieldsFilterSortGroupbyOverheadCase,
  recordRead50k50Fields50x1kPagesCase,
  recordCreateMixed1k20FieldsBulkCreateCase,
  recordDuplicateGridBlockDuplicate1kCase,
  recordDuplicateSingleRecordSequential100Case,
  recordUpdateMixed1k20FieldsBulkUpdateCase,
  recordUpdateAttachmentInsert100Case,
  recordUpdateAttachmentInsert1kCase,
  recordUpdate1kLinkCellsBulkUpdateCase,
  recordUpdateSingleForeignFirstNameFanout100_4kCase,
  recordUpdateSingleForeignSelectFanout100_4kCase,
  recordReorder10kMoveLast1kToFrontCase,
  recordUndoDelete1kCase,
  recordRedoDelete1kCase,
  recordPasteFlat10k20FieldsCopyPasteCase,
  recordPasteFlat10k4FieldsCopyPasteCase,
  recordPasteMixed10k20FieldsComplexCopyPasteCase,
  selectionPaste10kExpandRowsAndFieldsStreamCase,
] satisfies PerfCase[];

const caseById = new Map(cases.map((perfCase) => [perfCase.id, perfCase]));
const caseAliases = new Map([
  ["smoke", "smoke/auth-user"],
  ["auth-user", "smoke/auth-user"],
  ["formula", "formula/10k-calc"],
  ["formula/10k", "formula/10k-calc"],
  ["formula/10k-5", "formula/10k-5-concurrent"],
  ["formula/10k/concurrent", "formula/10k-5-concurrent"],
  ["lookup/conditional", "lookup/conditional-10k"],
  ["conditional-lookup", "lookup/conditional-10k"],
  ["rollup/conditional", "rollup/conditional-10k"],
  ["conditional-rollup", "rollup/conditional-10k"],
  ["lookup/dual-link-first-link", "lookup/dual-link-computed-first-link-4k"],
  [
    "lookup/dual-link-first-link/get-record",
    "lookup/dual-link-computed-first-link-1of4k-get-record",
  ],
  [
    "lookup/dual-link-first-link/get-records",
    "lookup/dual-link-computed-first-link-1of4k-get-records",
  ],
  ["lookup/dual-link-repoint", "lookup/dual-link-computed-repoint-2k"],
  ["lookup/search-index", "search/search-index-on-10k-20search-fields"],
  ["lookup/search-index/off", "search/search-index-off-10k-20search-fields"],
  ["lookup/search-index/on", "search/search-index-on-10k-20search-fields"],
  ["search/search-index", "search/search-index-on-10k-20search-fields"],
  ["search/search-index/off", "search/search-index-off-10k-20search-fields"],
  ["search/search-index/on", "search/search-index-on-10k-20search-fields"],
  ["search-index/lookup", "search/search-index-on-10k-20search-fields"],
  ["search-index/50k/off", "search/search-index-off-50k-20search-fields"],
  ["search-index/50k/on", "search/search-index-on-50k-20search-fields"],
  ["field-create", "field-create/10k-create-5-simple-fields"],
  ["field-create/5-simple", "field-create/10k-create-5-simple-fields"],
  ["field-create/simple", "field-create/10k-create-5-simple-fields"],
  ["field-create/5-formula", "field-create/10k-create-5-formula-fields"],
  ["field-create/formula", "field-create/10k-create-5-formula-fields"],
  ["field-create/19-fields", "field-create/mixed-10k-create-19-fields"],
  ["field-create/single-select", "field-create/single-select-1k-options"],
  ["select-options/1k", "field-create/single-select-1k-options"],
  ["field-convert", "field-convert/10k-multi-select-to-text"],
  ["field-convert/select-to-text", "field-convert/10k-multi-select-to-text"],
  ["field-convert/text-to-formula", "field-convert/10k-text-to-formula"],
  ["convert/select-to-text", "field-convert/10k-multi-select-to-text"],
  ["convert/text-to-formula", "field-convert/10k-text-to-formula"],
  ["field-convert/link-to-text", "field-convert/10k-link-to-text"],
  ["field-convert/text-to-link", "field-convert/10k-text-to-link"],
  ["convert/link-to-text", "field-convert/10k-link-to-text"],
  ["convert/text-to-link", "field-convert/10k-text-to-link"],
  [
    "field-update",
    "field-update/v2-only-10k-select-option-rename-computed-cascade",
  ],
  [
    "field-update/select-rename",
    "field-update/v2-only-10k-select-option-rename-computed-cascade",
  ],
  ["field-delete", "field-delete/mixed-10k-delete-19-fields"],
  ["field-delete/19-fields", "field-delete/mixed-10k-delete-19-fields"],
  ["field-restore", "field-restore/10k-description-field"],
  ["field-restore/10k", "field-restore/10k-description-field"],
  ["restore-field/10k", "field-restore/10k-description-field"],
  ["field-duplicate", "field-duplicate/conditional-lookup-10k"],
  ["field-duplicate/lookup", "field-duplicate/conditional-lookup-10k"],
  ["duplicate/lookup", "field-duplicate/conditional-lookup-10k"],
  ["duplicate-table", "duplicate-table/10k-20f"],
  ["duplicate-table/mixed", "duplicate-table/10k-20f"],
  ["duplicate-table/10k-20fields", "duplicate-table/10k-20f"],
  ["duplicate-table/complex", "duplicate-table/10k-25f-5formula"],
  ["duplicate-base", "duplicate-base/10k-3tables-link-2workflow"],
  ["duplicate-base/3tables", "duplicate-base/10k-3tables-link-2workflow"],
  ["duplicate-base/stream", "duplicate-base/10k-3tables-link-2workflow-stream"],
  [
    "import-base/stream",
    "import-base/v2-only-complex-3x10k-3tables-2workflow-stream",
  ],
  ["import-base/simple", "import-base/v2-only-simple-1x1k-table-stream"],
  ["import-base/simple-10k", "import-base/v2-only-simple-1x10k-table-stream"],
  [
    "import-base/complex",
    "import-base/v2-only-complex-3x10k-3tables-2workflow-stream",
  ],
  ["import-base/t2377", "import-base/v2-only-user-t2377-tea-stream"],
  ["import-base/user-t2377", "import-base/v2-only-user-t2377-tea-stream"],
  ["export-base/stream", "export-base/10k-3tables-link-2workflow-stream"],
  ["table-create", "table-create/10x-20f-no-records"],
  ["table-create/10x", "table-create/10x-20f-no-records"],
  ["table-create/1k-records", "table-create/1x-20f-1k-records"],
  ["table-create/5k-records", "table-create/1x-20f-5k-records"],
  ["table-create/inline-records", "table-create/1x-20f-1k-records"],
  ["table-delete", "table-delete/10k-20f"],
  ["table-delete/10k", "table-delete/10k-20f"],
  ["table-delete/link-detach", "table-delete/10k-20f-link-detach"],
  ["table-delete/link", "table-delete/10k-20f-link-detach"],
  ["table-restore", "table-restore/10k-20f"],
  ["table-restore/10k", "table-restore/10k-20f"],
  ["table-restore/link", "table-restore/10k-20f-link-1k"],
  ["table-restore/10k-link", "table-restore/10k-20f-link-1k"],
  ["csv-import", "csv-import/mixed-10k-20fields-inplace-import"],
  ["csv-import/10k", "csv-import/mixed-10k-20fields-inplace-import"],
  ["csv-import/10k-20fields", "csv-import/mixed-10k-20fields-inplace-import"],
  [
    "csv-import/create-table",
    "csv-import/mixed-1k-20fields-create-table-import",
  ],
  [
    "csv-import/1k-create-table",
    "csv-import/mixed-1k-20fields-create-table-import",
  ],
  [
    "csv-import/10k-create-table",
    "csv-import/mixed-10k-20fields-create-table-import",
  ],
  ["form-submit", "form-submit/sequential-200"],
  ["form-submit/200", "form-submit/sequential-200"],
  ["selection-clear", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["clear/1k-20fields", "selection-clear/flat-1k-20fields-cell-clear-stream"],
  ["record-delete", "record-delete/delete-1k"],
  ["delete/1k", "record-delete/delete-1k"],
  ["record-delete/stream", "record-delete/delete-stream-1k"],
  ["delete-stream/1k", "record-delete/delete-stream-1k"],
  ["record-delete/stream-10k", "record-delete/delete-stream-10k"],
  ["delete-stream/10k", "record-delete/delete-stream-10k"],
  ["record-delete/link", "record-delete/link-trash-1k"],
  ["delete/link-trash", "record-delete/link-trash-1k"],
  ["record-read", "record-read/10k-50fields-10x1k-pages"],
  ["get-records", "record-read/10k-50fields-10x1k-pages"],
  ["get-records/10k", "record-read/10k-50fields-10x1k-pages"],
  ["read/10k-50fields", "record-read/10k-50fields-10x1k-pages"],
  [
    "record-read/query-overhead",
    "record-read/10k-50fields-filter-sort-groupby-overhead",
  ],
  [
    "get-records/query-overhead",
    "record-read/10k-50fields-filter-sort-groupby-overhead",
  ],
  ["record-create", "record-create/mixed-1k-20fields-bulk-create"],
  ["create/1k", "record-create/mixed-1k-20fields-bulk-create"],
  ["create/1k-mixed-20fields", "record-create/mixed-1k-20fields-bulk-create"],
  ["record-duplicate", "record-duplicate/grid-block-duplicate-1k"],
  ["record-duplicate/grid", "record-duplicate/grid-block-duplicate-1k"],
  ["duplicate-record/grid", "record-duplicate/grid-block-duplicate-1k"],
  ["record-duplicate/single", "record-duplicate/single-record-sequential-100"],
  ["duplicate-record/single", "record-duplicate/single-record-sequential-100"],
  ["record-update", "record-update/mixed-1k-20fields-bulk-update"],
  ["update/1k", "record-update/mixed-1k-20fields-bulk-update"],
  ["update/1k-mixed-20fields", "record-update/mixed-1k-20fields-bulk-update"],
  ["record-update/attachment", "record-update/attachment-insert-100"],
  ["update/attachment-100", "record-update/attachment-insert-100"],
  ["update/attachment-1k", "record-update/attachment-insert-1k"],
  ["record-update/link", "record-update/1k-link-cells-bulk-update"],
  ["update/1k-link", "record-update/1k-link-cells-bulk-update"],
  ["record-reorder", "record-reorder/10k-move-last-1k-to-front"],
  ["reorder/10k-last-1k", "record-reorder/10k-move-last-1k-to-front"],
  ["reorder/last-1k-front", "record-reorder/10k-move-last-1k-to-front"],
  ["record-undo", "record-undo/delete-1k"],
  ["undo/1k", "record-undo/delete-1k"],
  ["record-redo", "record-redo/delete-1k"],
  ["redo/1k", "record-redo/delete-1k"],
  ["record-paste", "record-paste/flat-10k-4fields-copy-paste"],
  ["paste/10k", "record-paste/flat-10k-4fields-copy-paste"],
  ["paste/10k-20fields", "record-paste/flat-10k-20fields-copy-paste"],
  [
    "paste/10k-mixed-20fields",
    "record-paste/mixed-10k-20fields-complex-copy-paste",
  ],
  ["paste/10k-complex", "record-paste/mixed-10k-20fields-complex-copy-paste"],
  [
    "selection-paste/expand-stream",
    "selection-paste/10k-expand-rows-and-fields-stream",
  ],
  ["paste/expand-stream", "selection-paste/10k-expand-rows-and-fields-stream"],
]);

export const listPerfCaseIds = () => cases.map((perfCase) => perfCase.id);

export const resolvePerfCaseIds = (
  caseFilter = "smoke/auth-user",
): string[] => {
  const trimmed = caseFilter.trim();
  if (!trimmed || trimmed === "all" || trimmed === "*") {
    return listPerfCaseIds();
  }

  const caseIds = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((caseId) => caseAliases.get(caseId) ?? caseId);

  const unknownCaseIds = caseIds.filter((caseId) => !caseById.has(caseId));
  if (unknownCaseIds.length > 0) {
    throw new Error(
      `Unsupported PERF_LAB_CASE_FILTER: ${unknownCaseIds.join(
        ", ",
      )}. Available cases: ${listPerfCaseIds().join(", ")}, or "all".`,
    );
  }

  return [...new Set(caseIds)];
};

export const resolvePerfCaseIdsWithExclusions = (
  caseFilter = "smoke/auth-user",
  excludeCaseFilter = "",
): string[] => {
  const caseIds = resolvePerfCaseIds(caseFilter);
  const excludeCaseIds = excludeCaseFilter.trim()
    ? new Set(resolvePerfCaseIds(excludeCaseFilter))
    : new Set<string>();

  return caseIds.filter((caseId) => !excludeCaseIds.has(caseId));
};

export const getPerfCase = (caseId: string): PerfCase => {
  const canonicalCaseId = caseAliases.get(caseId) ?? caseId;
  const perfCase = caseById.get(canonicalCaseId);
  if (perfCase) {
    return perfCase;
  }

  throw new Error(
    `Unsupported PERF_LAB_CASE_ID: ${caseId}. Available cases: ${cases
      .map(({ id }) => id)
      .join(", ")}`,
  );
};

export const listPerfCases = (caseFilter?: string) =>
  resolvePerfCaseIds(caseFilter).map(getPerfCase);
