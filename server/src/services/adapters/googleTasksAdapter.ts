import * as googleTasksService from '../googleTasksService';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 60_000,
};

export const getTaskLists = wrap(googleTasksService.getTaskLists, { ...BREAKER_OPTS, name: 'gtasks.getTaskLists' });
export const getTasksFromList = wrap(googleTasksService.getTasksFromList, { ...BREAKER_OPTS, name: 'gtasks.getTasksFromList' });
export const getAllTasks = wrap(googleTasksService.getAllTasks, { ...BREAKER_OPTS, name: 'gtasks.getAllTasks' });
export const createTask = wrap(googleTasksService.createTask, { ...BREAKER_OPTS, name: 'gtasks.createTask' });
export const markTaskDone = wrap(googleTasksService.markTaskDone, { ...BREAKER_OPTS, name: 'gtasks.markTaskDone' });
