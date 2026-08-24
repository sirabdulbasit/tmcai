/**
 * ONE Meta Graph API version for every outbound WhatsApp path.
 *
 * Owner, 2026-08-24, acting on a redundancy audit. The audit found three independent Meta
 * senders; there are FOUR, on THREE different Graph versions:
 *
 *   services/notifications/whatsappNotifierService.ts   v18.0
 *   services/whatsapp/MetaProvider.ts                   v18.0
 *   services/whatsappService.ts                         v19.0
 *   services/connectorService.ts                        v21.0
 *
 * Consolidating the four SENDERS is a real refactor and is not what this file does. What it
 * removes is the quieter half of the problem: a message can succeed on one path and fail on
 * another purely because the versions differ, and nothing reconciles them — the same shape as
 * the silent-send incidents already in the change log, where outbound "worked" on the path
 * nobody was reading.
 *
 * Pinned to v19.0: the middle of the three in use, already carrying live message traffic
 * (whatsappService), so nothing is upgraded or downgraded across a major boundary by a cleanup
 * commit. Moving it later is now a one-line decision instead of a four-file hunt.
 */

/** The Graph API version every WhatsApp caller must use. */
export const META_GRAPH_VERSION = 'v19.0';

/** Base URL, e.g. https://graph.facebook.com/v19.0 */
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
