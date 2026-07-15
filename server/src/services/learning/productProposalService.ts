/**
 * Nexeo Self-Learning — Product Proposal Service (Phase 2)
 *
 * Promotes an approved gap into a structured product proposal. Phase 4
 * adds an LLM-powered ProductManagerAgent that fleshes out the
 * proposalMarkdown with user stories + acceptance criteria; for now
 * we ship a deterministic scaffold so admins can review + edit.
 *
 * Hard rule: proposals start in status='draft'. Even Brain-authored
 * proposals require explicit admin click to move forward.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('product-proposal');

/**
 * Create a proposal from an approved gap. Returns the new proposal id.
 * Caller (route layer) MUST have verified admin permissions.
 */
export async function createFromGap(args: {
  gapId: string;
  clientNumber: string;
  authorUserId: number;
}): Promise<{ id: string; error?: string }> {
  const gap = await prisma.brainDetectedGap.findUnique({ where: { id: args.gapId } });
  if (!gap) return { id: '', error: 'gap not found' };
  if (gap.clientNumber !== args.clientNumber) {
    return { id: '', error: 'cross-tenant promotion refused' };
  }
  if (gap.status !== 'approved') {
    return { id: '', error: `gap must be in status 'approved' to promote; current: ${gap.status}` };
  }

  // Deterministic proposal scaffold built from the gap's structured
  // fields. Session 4's ProductManagerAgent replaces this with LLM-
  // generated content; the markdown structure stays the same so the
  // UI / approval flow doesn't need to change.
  const proposalMarkdown = buildProposalMarkdown(gap);

  const proposal = await prisma.brainProductProposal.create({
    data: {
      clientNumber: args.clientNumber,
      userId: gap.userId,
      gapId: gap.id,
      title: gap.title,
      problemStatement: gap.description,
      businessImpact: `Business impact classified as ${gap.businessImpact ?? 'medium'} during gap detection.`,
      userImpact: `Frequency count: ${gap.frequencyCount}. Affected surfaces: ${(gap.affectedSurfaces ?? []).join(', ') || 'unspecified'}.`,
      affectedSurfaces: gap.affectedSurfaces,
      affectedConnectors: gap.affectedConnectors,
      affectedServices: [],
      proposalMarkdown,
      riskLevel: gap.riskLevel ?? 'medium',
      priority: gap.businessImpact === 'critical' ? 'high'
        : gap.businessImpact === 'high' ? 'high'
        : 'medium',
      status: 'draft',
      createdByBrain: true,
    },
  });

  // Mark the source gap as converted (don't keep proposing the same
  // gap on the next sweep).
  await prisma.brainDetectedGap.update({
    where: { id: gap.id },
    data: { status: 'converted_to_proposal' },
  });

  log.info('proposal created from gap', { gapId: gap.id, proposalId: proposal.id });
  return { id: proposal.id };
}

function buildProposalMarkdown(gap: {
  title: string;
  description: string;
  evidence: any;
  suggestedAction: string | null;
  gapType: string;
  affectedSurfaces: string[];
  frequencyCount: number;
}): string {
  const evidence = typeof gap.evidence === 'object' && gap.evidence !== null
    ? Object.entries(gap.evidence)
        .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
        .join('\n')
    : '(no structured evidence)';

  return `# ${gap.title}

## Problem Statement
${gap.description}

## Evidence
${evidence}

## Affected Surfaces
${gap.affectedSurfaces.length ? gap.affectedSurfaces.map((s) => `- ${s}`).join('\n') : '- (tenant-wide)'}

## User Stories (draft — edit before approval)
- As a user, I want ${gap.gapType.replace(/_/g, ' ')} to be resolved so that my workflow stays smooth.

## Acceptance Criteria (draft)
- [ ] The reported failure mode (\`${gap.gapType}\`) no longer recurs at the observed frequency.
- [ ] No regression on existing surfaces.
- [ ] Data integrity and tenant isolation rules unaffected.

## Suggested Approach
${gap.suggestedAction ?? '(Brain did not suggest a specific approach — admin to define)'}

## Privacy / Security Considerations
- Verify no cross-user or cross-tenant data exposure introduced.
- Verify Brain still cannot speak/act in the user's identity without consent.
- Verify suppression gates (quiet hours, rate limits, daily caps) still apply.

## Approval Required
This proposal is in **draft** status. Admin must review the above sections, edit where needed, and approve before it can be converted to a development request.
`;
}

export async function approveProposal(proposalId: string, approverId: number, clientNumber: string) {
  const proposal = await prisma.brainProductProposal.findUnique({ where: { id: proposalId } });
  if (!proposal || proposal.clientNumber !== clientNumber) return { ok: false, error: 'not found' };
  if (proposal.status === 'approved') return { ok: false, error: 'already approved' };
  await prisma.brainProductProposal.update({
    where: { id: proposalId },
    data: { status: 'approved', approvedBy: approverId, approvedAt: new Date() },
  });
  return { ok: true };
}

export async function rejectProposal(proposalId: string, _rejecterId: number, clientNumber: string) {
  const proposal = await prisma.brainProductProposal.findUnique({ where: { id: proposalId } });
  if (!proposal || proposal.clientNumber !== clientNumber) return { ok: false, error: 'not found' };
  await prisma.brainProductProposal.update({
    where: { id: proposalId },
    data: { status: 'rejected' },
  });
  return { ok: true };
}

export async function listProposals(args: { clientNumber: string; status?: string; limit?: number }) {
  const where: any = { clientNumber: args.clientNumber };
  if (args.status && args.status !== 'all') where.status = args.status;
  return prisma.brainProductProposal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(args.limit ?? 100, 500),
  });
}
