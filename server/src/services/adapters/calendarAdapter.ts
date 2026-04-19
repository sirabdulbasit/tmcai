import * as calendarService from '../calendarService';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 60_000,
};

export const getTodayEvents = wrap(calendarService.getTodayEvents, { ...BREAKER_OPTS, name: 'calendar.getTodayEvents' });
export const getEvents = wrap(calendarService.getEvents, { ...BREAKER_OPTS, name: 'calendar.getEvents' });
export const getUpcomingEvents = wrap(calendarService.getUpcomingEvents, { ...BREAKER_OPTS, name: 'calendar.getUpcomingEvents' });
export const createEvent = wrap(calendarService.createEvent, { ...BREAKER_OPTS, name: 'calendar.createEvent' });
export const findFreeTime = wrap(calendarService.findFreeTime, { ...BREAKER_OPTS, name: 'calendar.findFreeTime' });
export const deleteEvent = wrap(calendarService.deleteEvent, { ...BREAKER_OPTS, name: 'calendar.deleteEvent' });
