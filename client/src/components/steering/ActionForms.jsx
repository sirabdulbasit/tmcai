/**
 * HaseebOS v15 L4.2 — 15 embedded action execution interfaces.
 *
 * Single registry maps each of the 15 user-facing action types to a form.
 * All forms share the same submission pipeline via api.post('/actions/execute',{})
 * so the React surface stays declarative and the server-side handler registry
 * remains the single source of truth for shape + risk tier.
 *
 * Each form is intentionally minimal — the goal is "a functioning UI for every
 * action", not a bespoke UX. Styling inherits from SteeringWheelPage.css.
 */
import { useState } from 'react';
import api from '../../services/api';

// ─── Shared primitive inputs ────────────────────────────────────────
function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#999' }}>{label}</span>
      {children}
    </label>
  );
}

function Text({ value, onChange, ...rest }) {
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }}
      {...rest}
    />
  );
}

function Textarea({ value, onChange, rows = 4 }) {
  return (
    <textarea
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }}
    />
  );
}

function Submit({ label = 'Submit', onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        marginTop: 8,
        padding: '8px 14px',
        background: '#0a4',
        color: '#fff',
        border: 0,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

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
  if (busy) return <div style={{ color: '#aaa', marginTop: 8 }}>Executing…</div>;
  if (err) return <div style={{ color: '#e55', marginTop: 8 }}>{err}</div>;
  if (result) return (
    <pre style={{ background: '#0a0a0a', padding: 8, fontSize: 12, marginTop: 8, overflow: 'auto' }}>
      {JSON.stringify(result, null, 2)}
    </pre>
  );
  return null;
}

// ─── 15 forms ────────────────────────────────────────────────────────
// 1. send_email
function SendEmailForm() {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const { busy, err, result, run } = useActionSubmit('send_email');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="To"><Text value={to} onChange={setTo} /></Field>
      <Field label="Subject"><Text value={subject} onChange={setSubject} /></Field>
      <Field label="Body"><Textarea value={body} onChange={setBody} rows={6} /></Field>
      <Submit onClick={() => run({ to, subject, body })} disabled={busy || !to} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 2. send_email_reply
function SendEmailReplyForm() {
  const [threadId, setThreadId] = useState('');
  const [body, setBody] = useState('');
  const { busy, err, result, run } = useActionSubmit('send_email_reply');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Thread ID"><Text value={threadId} onChange={setThreadId} /></Field>
      <Field label="Reply body"><Textarea value={body} onChange={setBody} rows={6} /></Field>
      <Submit onClick={() => run({ threadId, body })} disabled={busy || !threadId} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 3. forward_email
function ForwardEmailForm() {
  const [messageId, setMessageId] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const { busy, err, result, run } = useActionSubmit('forward_email');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Message ID"><Text value={messageId} onChange={setMessageId} /></Field>
      <Field label="To"><Text value={to} onChange={setTo} /></Field>
      <Field label="Note"><Textarea value={note} onChange={setNote} rows={3} /></Field>
      <Submit onClick={() => run({ messageId, to, note })} disabled={busy || !messageId} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 4. send_whatsapp_message
function SendWhatsappForm() {
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const { busy, err, result, run } = useActionSubmit('send_whatsapp_message');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Phone"><Text value={to} onChange={setTo} /></Field>
      <Field label="Message"><Textarea value={body} onChange={setBody} rows={4} /></Field>
      <Submit onClick={() => run({ to, body })} disabled={busy || !to} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 5. send_chat_reply
function SendChatReplyForm() {
  const [spaceId, setSpaceId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [body, setBody] = useState('');
  const { busy, err, result, run } = useActionSubmit('send_chat_reply');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Space"><Text value={spaceId} onChange={setSpaceId} /></Field>
      <Field label="Thread (optional)"><Text value={threadId} onChange={setThreadId} /></Field>
      <Field label="Message"><Textarea value={body} onChange={setBody} rows={4} /></Field>
      <Submit onClick={() => run({ spaceId, threadId, body })} disabled={busy || !spaceId} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 6. create_event
function CreateEventForm() {
  const [title, setTitle] = useState('');
  const [startTs, setStartTs] = useState('');
  const [endTs, setEndTs] = useState('');
  const [attendees, setAttendees] = useState('');
  const { busy, err, result, run } = useActionSubmit('create_event');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Title"><Text value={title} onChange={setTitle} /></Field>
      <Field label="Start (ISO)"><Text value={startTs} onChange={setStartTs} /></Field>
      <Field label="End (ISO)"><Text value={endTs} onChange={setEndTs} /></Field>
      <Field label="Attendees (comma)"><Text value={attendees} onChange={setAttendees} /></Field>
      <Submit
        onClick={() => run({ title, startTs, endTs, attendees: attendees.split(',').map((s) => s.trim()).filter(Boolean) })}
        disabled={busy || !title}
      />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 7. reschedule_event
function RescheduleEventForm() {
  const [eventId, setEventId] = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');
  const { busy, err, result, run } = useActionSubmit('reschedule_event');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Event ID"><Text value={eventId} onChange={setEventId} /></Field>
      <Field label="New start (ISO)"><Text value={newStart} onChange={setNewStart} /></Field>
      <Field label="New end (ISO)"><Text value={newEnd} onChange={setNewEnd} /></Field>
      <Submit onClick={() => run({ eventId, newStart, newEnd })} disabled={busy || !eventId} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 8. cancel_event
function CancelEventForm() {
  const [eventId, setEventId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, err, result, run } = useActionSubmit('cancel_event');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Event ID"><Text value={eventId} onChange={setEventId} /></Field>
      <Field label="Reason"><Textarea value={reason} onChange={setReason} rows={2} /></Field>
      <Submit onClick={() => run({ eventId, reason })} disabled={busy || !eventId} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 9. create_task
function CreateTaskForm() {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const { busy, err, result, run } = useActionSubmit('create_task');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Title"><Text value={title} onChange={setTitle} /></Field>
      <Field label="Notes"><Textarea value={notes} onChange={setNotes} rows={3} /></Field>
      <Field label="Due date (ISO)"><Text value={dueDate} onChange={setDueDate} /></Field>
      <Submit onClick={() => run({ title, notes, dueDate })} disabled={busy || !title} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 10. reassign_task
function ReassignTaskForm() {
  const [taskId, setTaskId] = useState('');
  const [assignee, setAssignee] = useState('');
  const { busy, err, result, run } = useActionSubmit('reassign_task');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Task ID"><Text value={taskId} onChange={setTaskId} /></Field>
      <Field label="New assignee (email or id)"><Text value={assignee} onChange={setAssignee} /></Field>
      <Submit onClick={() => run({ taskId, assignee })} disabled={busy || !taskId || !assignee} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 11. create_odoo_lead
function CreateOdooLeadForm() {
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [description, setDescription] = useState('');
  const { busy, err, result, run } = useActionSubmit('create_odoo_lead');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Lead name"><Text value={name} onChange={setName} /></Field>
      <Field label="Contact email"><Text value={contactEmail} onChange={setContactEmail} /></Field>
      <Field label="Description"><Textarea value={description} onChange={setDescription} rows={3} /></Field>
      <Submit onClick={() => run({ name, contactEmail, description })} disabled={busy || !name} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 12. create_odoo_opportunity
function CreateOdooOppForm() {
  const [name, setName] = useState('');
  const [expectedRevenue, setExpectedRevenue] = useState('');
  const [stageId, setStageId] = useState('');
  const { busy, err, result, run } = useActionSubmit('create_odoo_opportunity');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Opportunity name"><Text value={name} onChange={setName} /></Field>
      <Field label="Expected revenue"><Text value={expectedRevenue} onChange={setExpectedRevenue} /></Field>
      <Field label="Stage ID"><Text value={stageId} onChange={setStageId} /></Field>
      <Submit
        onClick={() => run({ name, expectedRevenue: Number(expectedRevenue) || undefined, stageId: Number(stageId) || undefined })}
        disabled={busy || !name}
      />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 13. snooze
function SnoozeForm() {
  const [openItemId, setOpenItemId] = useState('');
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const { busy, err, result, run } = useActionSubmit('snooze');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="OpenItem ID"><Text value={openItemId} onChange={setOpenItemId} /></Field>
      <Field label="Snooze until (ISO)"><Text value={snoozeUntil} onChange={setSnoozeUntil} /></Field>
      <Submit
        onClick={() => run({ snoozeUntil }, { openItemId })}
        disabled={busy || !openItemId || !snoozeUntil}
      />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 14. escalate
function EscalateForm() {
  const [openItemId, setOpenItemId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, err, result, run } = useActionSubmit('escalate');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="OpenItem ID"><Text value={openItemId} onChange={setOpenItemId} /></Field>
      <Field label="Reason"><Textarea value={reason} onChange={setReason} rows={2} /></Field>
      <Submit onClick={() => run({ reason }, { openItemId })} disabled={busy || !openItemId} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

// 15. freeze_rule (governance)
function FreezeRuleForm() {
  const [ruleId, setRuleId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, err, result, run } = useActionSubmit('freeze_rule');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Field label="Rule ID"><Text value={ruleId} onChange={setRuleId} /></Field>
      <Field label="Reason"><Textarea value={reason} onChange={setReason} rows={2} /></Field>
      <Submit onClick={() => run({ ruleId, reason })} disabled={busy || !ruleId || !reason} />
      <Status busy={busy} err={err} result={result} />
    </div>
  );
}

export const ACTION_FORMS = [
  { key: 'send_email', label: 'Send Email', Component: SendEmailForm },
  { key: 'send_email_reply', label: 'Reply', Component: SendEmailReplyForm },
  { key: 'forward_email', label: 'Forward', Component: ForwardEmailForm },
  { key: 'send_whatsapp_message', label: 'Send WhatsApp', Component: SendWhatsappForm },
  { key: 'send_chat_reply', label: 'Chat Reply', Component: SendChatReplyForm },
  { key: 'create_event', label: 'Create Event', Component: CreateEventForm },
  { key: 'reschedule_event', label: 'Reschedule', Component: RescheduleEventForm },
  { key: 'cancel_event', label: 'Cancel Event', Component: CancelEventForm },
  { key: 'create_task', label: 'Create Task', Component: CreateTaskForm },
  { key: 'reassign_task', label: 'Reassign Task', Component: ReassignTaskForm },
  { key: 'create_odoo_lead', label: 'CRM: New Lead', Component: CreateOdooLeadForm },
  { key: 'create_odoo_opportunity', label: 'CRM: New Opp', Component: CreateOdooOppForm },
  { key: 'snooze', label: 'Snooze', Component: SnoozeForm },
  { key: 'escalate', label: 'Escalate', Component: EscalateForm },
  { key: 'freeze_rule', label: 'Freeze Rule', Component: FreezeRuleForm },
];

export default function ActionFormsPanel() {
  const [active, setActive] = useState(ACTION_FORMS[0].key);
  const current = ACTION_FORMS.find((f) => f.key === active) ?? ACTION_FORMS[0];
  const Component = current.Component;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, padding: 16 }}>
      <nav style={{ display: 'grid', gap: 4 }}>
        {ACTION_FORMS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setActive(f.key)}
            style={{
              textAlign: 'left',
              padding: 8,
              background: f.key === active ? '#1a1a1a' : 'transparent',
              color: '#ddd',
              border: '1px solid #2a2a2a',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </nav>
      <div>
        <h3 style={{ margin: 0, marginBottom: 10 }}>{current.label}</h3>
        <Component />
      </div>
    </div>
  );
}
