import { finite, identifier, instant, integer, oneOf, requireValue } from '../../core/validation';
import type { ChronologicalReport } from './chronological';
import { CHRONOLOGICAL_RESEARCH_POLICY } from './policy';

const row = (value: unknown): Record<string, unknown> => {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'research', 'damaged_object');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => { requireValue(Array.isArray(value), 'research', 'damaged_list'); return value; };
const texts = (value: unknown) => list(value).forEach(item => requireValue(typeof item === 'string', 'research', 'damaged_text'));
const date = (value: unknown) => { requireValue(typeof value === 'string', 'research', 'damaged_date'); instant(`${value}T00:00:00.000Z`, 'date'); };

/** Current report boundary. The execution store never calls this validator. */
export function validateChronologicalReport(value: unknown): asserts value is ChronologicalReport {
  const report = row(value);
  requireValue(JSON.stringify(report.policy) === JSON.stringify(CHRONOLOGICAL_RESEARCH_POLICY), 'research', 'unsupported_policy');
  oneOf(report.status, ['complete', 'unavailable', 'cancelled', 'budget_exceeded'], 'status');
  oneOf(report.gates, ['passed', 'failed'], 'gates'); oneOf(report.evidenceStatus, ['experimental', 'unavailable'], 'evidence');
  requireValue(report.pipelineValidated === false, 'research', 'unqualified_pipeline');
  oneOf(report.symbolClaim, ['conditional_on_supplied_symbols', 'recorded_selection_replay'], 'symbolClaim');
  oneOf(report.calendarClaim, ['as_of_session_open', 'retrospective_calendar'], 'calendarClaim');
  const data = row(report.data);
  identifier(data.id, 'data.id'); identifier(data.sourceRef, 'data.sourceRef'); instant(data.asOf, 'data.asOf'); instant(data.dataCutoff, 'data.dataCutoff');
  requireValue(data.dataCutoff <= data.asOf, 'data', 'future_cutoff');
  const selection = row(report.selection); oneOf(selection.kind, ['supplied_symbols', 'point_in_time'], 'selection');
  if (selection.kind === 'point_in_time') for (const value of list(selection.snapshots)) {
    const snapshot = row(value); identifier(snapshot.id, 'selection.id'); date(snapshot.tradingDate); identifier(snapshot.selectorId, 'selector');
    instant(snapshot.asOf, 'selection.asOf'); instant(snapshot.dataCutoff, 'selection.cutoff'); texts(snapshot.members); texts(snapshot.selected);
  }
  const configurations = list(report.configurations);
  for (const value of configurations) {
    const configuration = row(value); identifier(configuration.id, 'configuration'); texts(configuration.neighbors);
    for (const parameter of Object.values(row(configuration.parameters))) finite(parameter, 'parameter');
  }
  const folds = list(report.folds);
  for (const value of folds) {
    const result = row(value), fold = row(result.fold); identifier(fold.id, 'fold');
    list(fold.training).forEach(date); list(fold.validation).forEach(date);
    if (result.selectedConfigurationId !== null) identifier(result.selectedConfigurationId, 'selectedConfiguration');
    oneOf(result.status, ['passed', 'rejected'], 'fold.status'); texts(result.reasons);
    for (const value of list(result.training)) {
      const training = row(value); identifier(training.configurationId, 'training.configuration');
      if (training.score !== null) finite(training.score, 'training.score'); texts(training.reasons);
    }
  }
  for (const value of list(report.evaluations)) {
    const evaluation = row(value);
    for (const key of ['foldId', 'configurationId', 'scenarioId', 'symbol']) identifier(evaluation[key], key);
    oneOf(evaluation.phase, ['training', 'validation', 'neighbor', 'stress', 'baseline'], 'phase'); date(evaluation.tradingDate);
    instant(evaluation.sourceCutoff, 'sourceCutoff'); instant(evaluation.readCutoff, 'readCutoff');
    if (evaluation.netReturnPct !== null) finite(evaluation.netReturnPct, 'return');
    if (evaluation.trades !== null) integer(evaluation.trades, 'trades', 0);
    requireValue(evaluation.reason === null || typeof evaluation.reason === 'string', 'evaluation', 'damaged_reason');
  }
  const breadth = row(report.breadth);
  for (const key of ['suppliedConfigurations', 'testedConfigurations', 'evaluations', 'suppliedSymbols', 'suppliedSessions', 'independentValidationSessions']) integer(breadth[key], key, 0);
  list(breadth.unusedSessions).forEach(date);
  oneOf(report.holdout, ['untouched_relative_to_supplied_history', 'exhausted', 'unknown'], 'holdout');
  for (const value of list(report.exposure)) { const exposure = row(value); identifier(exposure.sourceRef, 'exposure.source'); date(exposure.tradingDate); }
  texts(report.reasons);
  const forecast = row(report.forecast);
  requireValue(forecast.status === 'unavailable' && typeof forecast.reason === 'string'
    && ['meanPnlCents', 'medianPnlCents', 'quantiles', 'probabilityOfProfit'].every(key => forecast[key] === null), 'forecast', 'unqualified_forecast');
  if (report.gates === 'passed') requireValue(report.status === 'complete' && report.holdout === 'untouched_relative_to_supplied_history'
    && folds.length > 0 && folds.every(value => row(value).status === 'passed') && list(report.reasons).length === 0, 'gates', 'inconsistent_result');
}
