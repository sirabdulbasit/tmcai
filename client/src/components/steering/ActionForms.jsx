/**
 * ActionFormsPanel — v2 on design tokens + UI library.
 * 15 embedded action execution interfaces, grouped in a left nav,
 * rendered as forms on the right with consistent spacing + risk banner.
 */
import { useState } from 'react';
import api from '../../services/api';
import { Button, Field, Input, Textarea, Card, RiskBanner, Empty } from '../ui';
import { Icon } from '../ui/Icon';

// ─── shared submit hook ───
function useActionSubmit(actionType) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (payload, extra = {}) => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const { data } = await api.post('/actions/execute', { actionType, payload, ...extra });
      setResult(data);
    } catch (e) {
      setErr(e?.response?.data?.error ?? e.message);
    } finally { setBusy(false); }
  };
  return { busy, result, err, run };
}

function Status({ busy, err, result }) {
  if (busy) return <div style={{ color: 'var(--text-muted)', marginTop: 'var(--s-3)' }}>Executing…</div>;
  if (err) return <div style={{ color: 'var(--danger)', marginTop: 'var(--s-3)' }}>{err}</div>;
  if (result) return (
    <pre style={{ background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 'var(--s-3)', fontSize: 'var(--fs-sm)', marginTop: 'var(--s-3)', overflow: 'auto', fontFamily: 'var(--font-mono)' }}>
      {JSON.stringify(result, null, 2)}
    </pre>
  );
  return null;
}

function FormShell({ title, description, risk, children, onSubmit, disabled, result, err, busy }) {
  return (
    <Card>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {description && <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>{description}</p>}
      {risk && (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <RiskBanner tier={risk.tier}>
            <Icon name="warning" size={16} />
            Risk: <strong>{risk.tier.toUpperCase()}</strong> · {risk.note}
          </RiskBanner>
        </div>
      )}
      <div style={{ marginTop: 'var(--s-5)' }}>{children}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-2)', marginTop: 'var(--s-4)' }}>
        <Button variant="primary" onClick={onSubmit} disabled={disabled || busy}>
          {busy ? 'Running…' : 'Execute'}
        </Button>
      </div>
      <Status busy={busy} err={err} result={result} />
    </Card>
  );
}

// ─── 15 forms ────────────────────────────────────
function SendEmailForm() {
  const [to, setTo] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const { busy, result, err, run } = useActionSubmit('send_email');
  return (
    <FormShell title="Send Email" description="Send a fresh email via Gmail." risk={{ tier: 'low', note: 'auto-executes · undoable' }}
               busy={busy} err={err} result={result} disabled={!to} onSubmit={() => run({ to, subject, body })}>
      <Field label="To"><Input value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Body"><Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </FormShell>
  );
}
function SendEmailReplyForm() {
  const [threadId, setThreadId] = useState(''); const [body, setBody] = useState('');
  const { busy, result, err, run } = useActionSubmit('send_email_reply');
  return (
    <FormShell title="Reply" description="Reply to an existing email thread." risk={{ tier: 'low', note: 'auto-executes · undoable' }}
               busy={busy} err={err} result={result} disabled={!threadId} onSubmit={() => run({ threadId, body })}>
      <Field label="Thread ID"><Input value={threadId} onChange={(e) => setThreadId(e.target.value)} /></Field>
      <Field label="Reply body"><Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </FormShell>
  );
}
function ForwardEmailForm() {
  const [messageId, setMessageId] = useState(''); const [to, setTo] = useState(''); const [note, setNote] = useState('');
  const { busy, result, err, run } = useActionSubmit('forward_email');
  return (
    <FormShell title="Forward Email" risk={{ tier: 'low', note: 'auto-executes' }}
               busy={busy} err={err} result={result} disabled={!messageId} onSubmit={() => run({ messageId, to, note })}>
      <Field label="Message ID"><Input value={messageId} onChange={(e) => setMessageId(e.target.value)} /></Field>
      <Field label="To"><Input value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Note"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormShell>
  );
}
function SendWhatsappForm() {
  const [to, setTo] = useState(''); const [body, setBody] = useState('');
  const { busy, result, err, run } = useActionSubmit('send_whatsapp_message');
  return (
    <FormShell title="Send WhatsApp" risk={{ tier: 'low', note: 'Meta Cloud API' }}
               busy={busy} err={err} result={result} disabled={!to} onSubmit={() => run({ to, body })}>
      <Field label="Phone"><Input value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Message"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </FormShell>
  );
}
function SendChatReplyForm() {
  const [spaceId, setSpaceId] = useState(''); const [threadId, setThreadId] = useState(''); const [body, setBody] = useState('');
  const { busy, result, err, run } = useActionSubmit('send_chat_reply');
  return (
    <FormShell title="Chat Reply" risk={{ tier: 'low', note: 'Google Chat' }}
               busy={busy} err={err} result={result} disabled={!spaceId} onSubmit={() => run({ spaceId, threadId, body })}>
      <Field label="Space"><Input value={spaceId} onChange={(e) => setSpaceId(e.target.value)} /></Field>
      <Field label="Thread (optional)"><Input value={threadId} onChange={(e) => setThreadId(e.target.value)} /></Field>
      <Field label="Message"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </FormShell>
  );
}
function CreateEventForm() {
  const [title, setTitle] = useState(''); const [startTs, setStartTs] = useState(''); const [endTs, setEndTs] = useState(''); const [attendees, setAttendees] = useState('');
  const { busy, result, err, run } = useActionSubmit('create_event');
  return (
    <FormShell title="Create Event" risk={{ tier: 'low', note: 'Google Calendar' }}
               busy={busy} err={err} result={result} disabled={!title}
               onSubmit={() => run({ title, startTs, endTs, attendees: attendees.split(',').map((s) => s.trim()).filter(Boolean) })}>
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Start (ISO)"><Input value={startTs} onChange={(e) => setStartTs(e.target.value)} /></Field>
      <Field label="End (ISO)"><Input value={endTs} onChange={(e) => setEndTs(e.target.value)} /></Field>
      <Field label="Attendees (comma-separated)"><Input value={attendees} onChange={(e) => setAttendees(e.target.value)} /></Field>
    </FormShell>
  );
}
function RescheduleEventForm() {
  const [eventId, setEventId] = useState(''); const [newStart, setNewStart] = useState(''); const [newEnd, setNewEnd] = useState('');
  const { busy, result, err, run } = useActionSubmit('reschedule_event');
  return (
    <FormShell title="Reschedule Event" risk={{ tier: 'low', note: 'notifies attendees' }}
               busy={busy} err={err} result={result} disabled={!eventId} onSubmit={() => run({ eventId, newStart, newEnd })}>
      <Field label="Event ID"><Input value={eventId} onChange={(e) => setEventId(e.target.value)} /></Field>
      <Field label="New start (ISO)"><Input value={newStart} onChange={(e) => setNewStart(e.target.value)} /></Field>
      <Field label="New end (ISO)"><Input value={newEnd} onChange={(e) => setNewEnd(e.target.value)} /></Field>
    </FormShell>
  );
}
function CancelEventForm() {
  const [eventId, setEventId] = useState(''); const [reason, setReason] = useState('');
  const { busy, result, err, run } = useActionSubmit('cancel_event');
  return (
    <FormShell title="Cancel Event" risk={{ tier: 'low', note: 'notifies attendees' }}
               busy={busy} err={err} result={result} disabled={!eventId} onSubmit={() => run({ eventId, reason })}>
      <Field label="Event ID"><Input value={eventId} onChange={(e) => setEventId(e.target.value)} /></Field>
      <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormShell>
  );
}
function CreateTaskForm() {
  const [title, setTitle] = useState(''); const [notes, setNotes] = useState(''); const [dueDate, setDueDate] = useState('');
  const { busy, result, err, run } = useActionSubmit('create_task');
  return (
    <FormShell title="Create Task" risk={{ tier: 'low', note: 'Google Tasks' }}
               busy={busy} err={err} result={result} disabled={!title} onSubmit={() => run({ title, notes, dueDate })}>
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Notes"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Field label="Due date (ISO)"><Input value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
    </FormShell>
  );
}
function ReassignTaskForm() {
  const [taskId, setTaskId] = useState(''); const [assignee, setAssignee] = useState('');
  const { busy, result, err, run } = useActionSubmit('reassign_task');
  return (
    <FormShell title="Reassign Task" risk={{ tier: 'low', note: 'notifies new owner' }}
               busy={busy} err={err} result={result} disabled={!taskId || !assignee} onSubmit={() => run({ taskId, assignee })}>
      <Field label="Task ID"><Input value={taskId} onChange={(e) => setTaskId(e.target.value)} /></Field>
      <Field label="New assignee (email or id)"><Input value={assignee} onChange={(e) => setAssignee(e.target.value)} /></Field>
    </FormShell>
  );
}
function CreateOdooLeadForm() {
  const [name, setName] = useState(''); const [contactEmail, setContactEmail] = useState(''); const [description, setDescription] = useState('');
  const { busy, result, err, run } = useActionSubmit('create_odoo_lead');
  return (
    <FormShell title="CRM — New Lead" risk={{ tier: 'low', note: 'Odoo CRM' }}
               busy={busy} err={err} result={result} disabled={!name} onSubmit={() => run({ name, contactEmail, description })}>
      <Field label="Lead name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Contact email"><Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></Field>
      <Field label="Description"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </FormShell>
  );
}
function CreateOdooOppForm() {
  const [name, setName] = useState(''); const [expectedRevenue, setExpectedRevenue] = useState(''); const [stageId, setStageId] = useState('');
  const { busy, result, err, run } = useActionSubmit('create_odoo_opportunity');
  return (
    <FormShell title="CRM — New Opportunity" risk={{ tier: 'low', note: 'Odoo CRM' }}
               busy={busy} err={err} result={result} disabled={!name}
               onSubmit={() => run({ name, expectedRevenue: Number(expectedRevenue) || undefined, stageId: Number(stageId) || undefined })}>
      <Field label="Opportunity name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Expected revenue"><Input value={expectedRevenue} onChange={(e) => setExpectedRevenue(e.target.value)} /></Field>
      <Field label="Stage ID"><Input value={stageId} onChange={(e) => setStageId(e.target.value)} /></Field>
    </FormShell>
  );
}
function SnoozeForm() {
  const [openItemId, setOpenItemId] = useState(''); const [snoozeUntil, setSnoozeUntil] = useState('');
  const { busy, result, err, run } = useActionSubmit('snooze');
  return (
    <FormShell title="Snooze" risk={{ tier: 'low', note: 'auto-wakes at snooze_until' }}
               busy={busy} err={err} result={result} disabled={!openItemId || !snoozeUntil} onSubmit={() => run({ snoozeUntil }, { openItemId })}>
      <Field label="OpenItem ID"><Input value={openItemId} onChange={(e) => setOpenItemId(e.target.value)} /></Field>
      <Field label="Snooze until (ISO)"><Input value={snoozeUntil} onChange={(e) => setSnoozeUntil(e.target.value)} /></Field>
    </FormShell>
  );
}
function EscalateForm() {
  const [openItemId, setOpenItemId] = useState(''); const [reason, setReason] = useState('');
  const { busy, result, err, run } = useActionSubmit('escalate');
  return (
    <FormShell title="Escalate" risk={{ tier: 'low', note: 'raises priority + notifies' }}
               busy={busy} err={err} result={result} disabled={!openItemId} onSubmit={() => run({ reason }, { openItemId })}>
      <Field label="OpenItem ID"><Input value={openItemId} onChange={(e) => setOpenItemId(e.target.value)} /></Field>
      <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormShell>
  );
}
function FreezeRuleForm() {
  const [ruleId, setRuleId] = useState(''); const [reason, setReason] = useState('');
  const { busy, result, err, run } = useActionSubmit('freeze_rule');
  return (
    <FormShell title="Freeze Rule" risk={{ tier: 'high', note: 'rule stops executing' }}
               busy={busy} err={err} result={result} disabled={!ruleId || !reason} onSubmit={() => run({ ruleId, reason })}>
      <Field label="Rule ID"><Input value={ruleId} onChange={(e) => setRuleId(e.target.value)} /></Field>
      <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormShell>
  );
}

export const ACTION_FORMS = [
  { key: 'send_email',            label: 'Send Email',           group: 'Communication', Component: SendEmailForm },
  { key: 'send_email_reply',      label: 'Reply',                group: 'Communication', Component: SendEmailReplyForm },
  { key: 'forward_email',         label: 'Forward',              group: 'Communication', Component: ForwardEmailForm },
  { key: 'send_whatsapp_message', label: 'Send WhatsApp',        group: 'Communication', Component: SendWhatsappForm },
  { key: 'send_chat_reply',       label: 'Chat Reply',           group: 'Communication', Component: SendChatReplyForm },
  { key: 'create_event',          label: 'Create Event',         group: 'Calendar',      Component: CreateEventForm },
  { key: 'reschedule_event',      label: 'Reschedule',           group: 'Calendar',      Component: RescheduleEventForm },
  { key: 'cancel_event',          label: 'Cancel Event',         group: 'Calendar',      Component: CancelEventForm },
  { key: 'create_task',           label: 'Create Task',          group: 'Task',          Component: CreateTaskForm },
  { key: 'reassign_task',         label: 'Reassign Task',        group: 'Task',          Component: ReassignTaskForm },
  { key: 'create_odoo_lead',      label: 'CRM: New Lead',        group: 'CRM',           Component: CreateOdooLeadForm },
  { key: 'create_odoo_opportunity', label: 'CRM: New Opp',       group: 'CRM',           Component: CreateOdooOppForm },
  { key: 'snooze',                label: 'Snooze',               group: 'Lifecycle',     Component: SnoozeForm },
  { key: 'escalate',              label: 'Escalate',             group: 'Lifecycle',     Component: EscalateForm },
  { key: 'freeze_rule',           label: 'Freeze Rule',          group: 'Governance',    Component: FreezeRuleForm },
];

export default function ActionFormsPanel() {
  const [active, setActive] = useState(ACTION_FORMS[0].key);
  const current = ACTION_FORMS.find((f) => f.key === active) ?? ACTION_FORMS[0];
  const Component = current.Component;

  const groups = ['Communication', 'Calendar', 'Task', 'CRM', 'Lifecycle', 'Governance'];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 'var(--s-5)', padding: 'var(--s-6)' }}>
      <nav>
        {groups.map((g) => (
          <div key={g} style={{ marginBottom: 'var(--s-4)' }}>
            <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-dim)', margin: '0 var(--s-2) var(--s-2)' }}>{g}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {ACTION_FORMS.filter((f) => f.group === g).map((f) => {
                const isActive = f.key === active;
                return (
                  <button key={f.key} type="button" onClick={() => setActive(f.key)}
                          style={{
                            textAlign: 'left',
                            padding: 'var(--s-2) var(--s-3)',
                            borderRadius: 'var(--r-md)',
                            background: isActive ? 'var(--accent-dim)' : 'transparent',
                            color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                            border: 0, cursor: 'pointer', fontSize: 'var(--fs-md)',
                          }}>
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div><Component /></div>
    </div>
  );
}
