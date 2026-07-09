import { register } from '../handlerRegistry';
// Lifecycle
import { SnoozeHandler } from './lifecycle/snooze';
import { CloseHandler } from './lifecycle/close';
import { ArchiveHandler } from './lifecycle/archive';
import { SplitItemHandler } from './lifecycle/splitItem';
import { MergeItemsHandler } from './lifecycle/mergeItems';
import { EscalateHandler } from './lifecycle/escalate';
import { DemoteHandler } from './lifecycle/demote';
// Communication
import { SendEmailHandler } from './communication/sendEmail';
import { SendEmailReplyHandler } from './communication/sendEmailReply';
import { ForwardEmailHandler } from './communication/forwardEmail';
import { SendSlackMessageHandler } from './communication/sendSlackMessage';
import { SendChatReplyHandler } from './communication/sendChatReply';
import { SendWhatsappMessageHandler } from './communication/sendWhatsappMessage';
// Calendar
import { CreateEventHandler } from './calendar/createEvent';
import { RescheduleEventHandler } from './calendar/rescheduleEvent';
import { CancelEventHandler } from './calendar/cancelEvent';
import { ProposeTimesHandler } from './calendar/proposeTimes';
import { AddAttendeeHandler } from './calendar/addAttendee';
// Task
import { CreateTaskHandler } from './task/createTask';
import { CompleteTaskHandler } from './task/completeTask';
import { ReassignTaskHandler } from './task/reassignTask';
import { AddSubtaskHandler } from './task/addSubtask';
// CRM
import { UpdateOdooCrmHandler } from './crm/updateOdooCrm';
import { CreateOdooLeadHandler } from './crm/createOdooLead';
import { CreateOdooOpportunityHandler } from './crm/createOdooOpportunity';
import { UpdateOdooOpportunityHandler } from './crm/updateOdooOpportunity';
// Orchestration
import { TransferToAgentHandler } from './orchestration/transferToAgent';
import { WaitForApprovalHandler } from './orchestration/waitForApproval';
import { ParallelFanOutHandler } from './orchestration/parallelFanOut';
// Brain
import { UpdatePriorityHandler } from './brain/updatePriority';
import { TagEntityHandler } from './brain/tagEntity';
import { ExtractInsightHandler } from './brain/extractInsight';
import { UpdateMemoryHandler } from './brain/updateMemory';
import { SyncThoughtToNotionHandler } from './brain/syncThoughtToNotion';
import { NotifyUserRiskHandler } from './brain/notifyUserRisk';
// Governance
import { RequestApprovalHandler } from './governance/requestApproval';
import { LogOverrideHandler } from './governance/logOverride';
import { FreezeRuleHandler } from './governance/freezeRule';

let registered = false;

export function registerAllHandlers(): void {
  if (registered) return;
  // Lifecycle (7)
  register(new SnoozeHandler());
  register(new CloseHandler());
  register(new ArchiveHandler());
  register(new SplitItemHandler());
  register(new MergeItemsHandler());
  register(new EscalateHandler());
  register(new DemoteHandler());
  // Communication (5/5)
  register(new SendEmailHandler());
  register(new SendEmailReplyHandler());
  register(new ForwardEmailHandler());
  register(new SendChatReplyHandler());
  register(new SendWhatsappMessageHandler());
  register(new SendSlackMessageHandler());
  // Calendar (5)
  register(new CreateEventHandler());
  register(new RescheduleEventHandler());
  register(new CancelEventHandler());
  register(new ProposeTimesHandler());
  register(new AddAttendeeHandler());
  // Task (4)
  register(new CreateTaskHandler());
  register(new CompleteTaskHandler());
  register(new ReassignTaskHandler());
  register(new AddSubtaskHandler());
  // CRM (4 of 4 — Odoo INT-1 connector is wired)
  register(new UpdateOdooCrmHandler());
  register(new CreateOdooLeadHandler());
  register(new CreateOdooOpportunityHandler());
  register(new UpdateOdooOpportunityHandler());
  // Orchestration (3/3)
  register(new TransferToAgentHandler());
  register(new WaitForApprovalHandler());
  register(new ParallelFanOutHandler());
  // Brain (4)
  register(new UpdatePriorityHandler());
  register(new TagEntityHandler());
  register(new ExtractInsightHandler());
  register(new UpdateMemoryHandler());
  register(new SyncThoughtToNotionHandler());
  register(new NotifyUserRiskHandler());
  // Governance (3)
  register(new RequestApprovalHandler());
  register(new LogOverrideHandler());
  register(new FreezeRuleHandler());
  registered = true;
}
