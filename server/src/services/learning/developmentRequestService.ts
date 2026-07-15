/**
 * Nexeo Self-Learning — Development Request Service (Phase 2)
 *
 * Final gated stage. Promotes an approved proposal into a development
 * request that carries the technical spec + (eventually) the PR URL.
 * Brain CANNOT deploy code or modify production — the spec only
 * describes the intended change; an actual human developer (or
 * Session 4's DeveloperAgent operating in branch + PR mode) does
 * the implementation.
 *
 * Hard rules (status machine):
 *   draft → awaiting_approval     (when admin clicks "Send for approval")
 *   awaiting_approval → approved_for_development  (admin click)
 *   approved_for_development → coding_in_progress (developer agent picks up)
 *   coding_in_progress → pr_created               (PR opened)
 *   pr_created → review_required → uat_required → approved_for_release
 *   approved_for_release → deployed               (release manager click)
 *
 * Every transition through "approval" or "release" gates require
 * explicit human action. Brain authors content + can flip
 * draft↔awaiting_approval and coding_in_progress↔pr_created, but
 * cannot flip approved_* states.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('development-request');

export async function createFromProposal(args: {
  proposalId: string;
  clientNumber: string;
  authorUserId: number;
}): Promise<{ id: string; error?: string }> {
  const proposal = await prisma.brainProductProposal.findUnique({ where: { id: args.proposalId } });
  if (!proposal) return { id: '', error: 'proposal not found' };
  if (proposal.clientNumber !== args.clientNumber) {
    return { id: '', error: 'cross-tenant promotion refused' };
  }
  if (proposal.status !== 'approved') {
    return { id: '', error: `proposal must be 'approved' to promote; current: ${proposal.status}` };
  }

  // Carry the proposal markdown into requirement_markdown verbatim;
  // technical_spec_markdown is filled in later by the Technical
  // Architect Agent (Session 4) OR manually edited.
  const devReq = await prisma.brainDevelopmentRequest.create({
    data: {
      clientNumber: args.clientNumber,
      userId: proposal.userId,
      gapId: proposal.gapId,
      proposalId: proposal.id,
      title: proposal.title,
      description: proposal.problemStatement,
      requirementMarkdown: proposal.proposalMarkdown,
      technicalSpecMarkdown: null,
      targetRepository: 'github.com/sirabdulbasit/tmcai',
      targetBranch: 'main',
      generatedBranch: null,
      pullRequestUrl: null,
      testStatus: 'not_started',
      securityStatus: 'not_started',
      status: 'draft',
      riskLevel: proposal.riskLevel ?? 'high',
      requestedBy: args.authorUserId,
    },
  });

  await prisma.brainProductProposal.update({
    where: { id: proposal.id },
    data: { status: 'converted_to_development' },
  });

  log.info('development request created from proposal', { proposalId: proposal.id, devReqId: devReq.id });
  return { id: devReq.id };
}

/**
 * Generate a technical-spec scaffold for a dev request. Phase 4
 * replaces this with the LLM-powered Technical Architect Agent;
 * for now we emit a structured Markdown template the admin fills in.
 */
export async function generateTechnicalSpec(args: {
  devRequestId: string;
  clientNumber: string;
}): Promise<{ ok: boolean; spec?: string; error?: string }> {
  const dr = await prisma.brainDevelopmentRequest.findUnique({ where: { id: args.devRequestId } });
  if (!dr || dr.clientNumber !== args.clientNumber) return { ok: false, error: 'not found' };

  const spec = `# Technical Specification — ${dr.title}

## Summary
${dr.description}

## Affected Backend Files / Services
- (Architect: enumerate the services that need to change)

## Affected Frontend Files / Components
- (Architect: enumerate the components that need to change)

## Database Schema Changes
- Migrations required: [yes / no]
- New tables: (list)
- New columns: (list)
- Index changes: (list)

## API Endpoints
- (List new / modified endpoints with methods, paths, request/response shape)

## Prisma Model Changes
- (Mirror of DB changes above in Prisma terms; back-relations etc.)

## Tenant Isolation Controls
- Every new table includes \`client_number\` and is filtered on it: [yes / no]
- Routes enforce \`req.user.clientNumber\` at handler entry: [yes / no]

## User Isolation Controls
- User-owned data is filtered by \`user_id\` at service layer: [yes / no]
- Cross-user access is structurally blocked: [yes / no]

## Suppression Gate Impact
- Quiet hours respected: [yes / no / N/A]
- Rate limits respected: [yes / no / N/A]
- Daily caps respected: [yes / no / N/A]

## Outbound Consent Impact
- Sends from user identity: [yes / no]
- If yes — explicit user-initiated chain enforced: [yes / no]
- If yes — outbound opt-in required: [yes / no]

## Connector Impact
- New connector dependencies: (list)
- Existing connector credential / auth changes: [yes / no]

## Audit Log Requirements
- New audit events emitted: (list)
- Existing audit events extended: [yes / no]

## Test Strategy
- Unit tests: (list services + cases)
- Integration tests: (list flows)
- Smoke tests: (list scenarios)
- Manual verification steps: (list)

## Security / Privacy Review
- Cross-user data exposure risk: [low / medium / high / critical]
- Cross-tenant data exposure risk: [low / medium / high / critical]
- Prompt injection surface added: [yes / no]
- Sensitive data stored: [yes / no — what fields]
- Encryption applied where needed: [yes / no]

## Rollback Plan
- Migration rollback: (describe down migration or fallback)
- Feature flag: (gate name if any)
- Deploy reversibility: (notes)

## Deployment Notes
- Migration commands: \`npx prisma migrate deploy\`
- Build commands: \`npm run build\`
- pm2 restart command: \`pm2 restart tmcai-server\`
- Frontend rebuild needed: [yes / no]
- Cron / interval changes: (notes)
`;

  await prisma.brainDevelopmentRequest.update({
    where: { id: args.devRequestId },
    data: { technicalSpecMarkdown: spec },
  });

  return { ok: true, spec };
}

export async function approveDevRequest(devReqId: string, approverId: number, clientNumber: string) {
  const dr = await prisma.brainDevelopmentRequest.findUnique({ where: { id: devReqId } });
  if (!dr || dr.clientNumber !== clientNumber) return { ok: false, error: 'not found' };
  // Only allow approval from awaiting_approval state — guards
  // against accidental re-approval and out-of-sequence transitions.
  if (dr.status !== 'awaiting_approval') {
    return { ok: false, error: `must be 'awaiting_approval'; current: ${dr.status}` };
  }
  await prisma.brainDevelopmentRequest.update({
    where: { id: devReqId },
    data: { status: 'approved_for_development', approvedBy: approverId, approvedAt: new Date() },
  });
  return { ok: true };
}

export async function rejectDevRequest(devReqId: string, _rejecterId: number, clientNumber: string) {
  const dr = await prisma.brainDevelopmentRequest.findUnique({ where: { id: devReqId } });
  if (!dr || dr.clientNumber !== clientNumber) return { ok: false, error: 'not found' };
  await prisma.brainDevelopmentRequest.update({
    where: { id: devReqId },
    data: { status: 'rejected' },
  });
  return { ok: true };
}

export async function listDevRequests(args: { clientNumber: string; status?: string; limit?: number }) {
  const where: any = { clientNumber: args.clientNumber };
  if (args.status && args.status !== 'all') where.status = args.status;
  return prisma.brainDevelopmentRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(args.limit ?? 100, 500),
  });
}
