/**
 * panelDecider — when a web Brain reply benefits from a structured
 * side view (open items list, contact card, calendar, deal), return
 * a PanelDirective that the frontend renders as a pop-out overlay
 * card (per user 2026-05-18: "Pop-out overlay card").
 *
 * Web only. WhatsApp drops the directive in channelRenderer.
 *
 * Scope of this commit: ONE panel kind — `open_items_list` for
 * intent=day_brief. It's the highest-value case (Day Brief on web
 * should show the actual list of items, not just describe them
 * in prose) and exercises the full pipeline (decide → emit →
 * render → click → overlay).
 *
 * Adding new kinds later: extend the switch; the renderer +
 * frontend overlay are kind-agnostic and key off PanelDirective.kind.
 */
import prisma from '../../db/prisma';
import type { PlanIntent } from './brainRetrievalPlanner';
import type { PanelDirective } from './channelRenderer';

export async function decidePanel(args: {
  userId: number;
  clientNumber: string;
  intent: PlanIntent;
}): Promise<PanelDirective | null> {
  if (args.intent === 'day_brief') {
    // Pull the items that should be on today's brief — same shape
    // as /open-items default. Cap at 20; the overlay card paginates
    // visually but the directive carries the ids only.
    try {
      const items = (await prisma.openItem.findMany({
        where: {
          userId: args.userId,
          status: { in: ['NEW', 'TRIAGED', 'DELEGATED', 'DRAFT', 'open'] as any },
        } as any,
        select: { id: true } as any,
        orderBy: [
          { priority: 'desc' },
          { dueDate: 'asc' as const },
          { createdAt: 'desc' },
        ],
        take: 20,
      })) as unknown as Array<{ id: string }>;
      if (items.length === 0) return null;
      return {
        kind: 'open_items_list',
        title: "Today's open items",
        itemIds: items.map((i) => i.id),
      };
    } catch {
      return null;
    }
  }

  // Other intents — no panel for now.
  return null;
}
