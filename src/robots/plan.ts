import { FULL_SESSION_CALENDAR, validFullSession } from '../core/exchange-session';
import { finite, identifier, instant, object, oneOf, requireValue } from '../core/validation';
import type { RobotSession, TemplateParameterContract } from './domain';


export function validateParameters(value: unknown, contract: TemplateParameterContract): void {
  const params = object(value, 'parameters', Object.keys(contract.parameters));
  for (const [key, bounds] of Object.entries(contract.parameters)) {
    finite(bounds.min, `parameterContract.${key}.min`);
    finite(bounds.max, `parameterContract.${key}.max`);
    requireValue(bounds.min <= bounds.max && typeof bounds.integer === 'boolean', `parameterContract.${key}`, 'invalid_bounds');
    const parameter = params[key];
    finite(parameter, `parameters.${key}`);
    requireValue(parameter >= bounds.min && parameter <= bounds.max
      && (!bounds.integer || Number.isSafeInteger(parameter)), `parameters.${key}`, 'outside_parameter_bounds');
  }
  for (const [lower, upper] of contract.strictlyOrdered) {
    requireValue(Object.hasOwn(params, lower) && Object.hasOwn(params, upper)
      && (params[lower] as number) < (params[upper] as number), 'parameters', 'invalid_parameter_order');
  }
}

export function validateSession(value: unknown): asserts value is RobotSession {
  const session = object(value, 'session', ['calendarId', 'tradingDate', 'timeZone', 'openAt', 'closeAt', 'calendarAsOf', 'provenanceRef']);
  identifier(session.calendarId, 'session.calendarId');
  identifier(session.provenanceRef, 'session.provenanceRef');
  oneOf(session.timeZone, ['America/New_York'], 'session.timeZone');
  for (const key of ['openAt', 'closeAt', 'calendarAsOf']) instant(session[key], `session.${key}`);
  requireValue(typeof session.tradingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.tradingDate), 'session.tradingDate', 'invalid_trading_date');
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const venueDate = (at: string) => {
    const parts = formatter.formatToParts(new Date(at));
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  };
  requireValue(session.calendarId === FULL_SESSION_CALENDAR
    ? validFullSession(session.tradingDate as string, session.openAt as string, session.closeAt as string)
    : session.tradingDate === venueDate(session.openAt as string) && session.tradingDate === venueDate(session.closeAt as string), 'session', 'session_date_mismatch');
  requireValue((session.openAt as string) < (session.closeAt as string), 'session', 'invalid_time_order');
}
