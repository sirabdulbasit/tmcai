import { registerAllHandlers } from '../services/actions/handlers';
import { executeViaRegistry } from '../services/actions/executeViaRegistry';
import * as undoSvc from '../services/actions/cascadingUndoService';
import prisma from '../db/prisma';
(async () => {
  registerAllHandlers();
  const cn = 'TMC-0001';
  const r1 = await executeViaRegistry({
    actionType: 'update_memory', clientNumber: cn, userId: 1,
    payload: { agentId: 'test_agent', memoryKey: `undo_${Date.now()}`, memoryValue: { v: 'first' } },
  });
  console.log(`action1=${r1.actionId} ok=${r1.ok}`);
  const prev = await undoSvc.preview(r1.actionId, cn);
  console.log(`preview: willUndoIds=${JSON.stringify(prev.willUndoIds)} dependents=${prev.dependents.length}`);
  const undo = await undoSvc.execute(r1.actionId, cn, 1, 'single');
  console.log(`undo.undoneIds=${JSON.stringify(undo.undoneIds)} failed=${undo.failed.length}`);
  const log = await prisma.actionUndoLog.findFirst({ where: { actionId: r1.actionId } });
  console.log(`undo_log_row=${log ? 'present' : 'missing'}`);
  const act = await prisma.agentAction.findUnique({ where: { id: r1.actionId } });
  console.log(`agent_action.undo_status=${act?.undoStatus}`);
  await prisma.$disconnect();
})();
