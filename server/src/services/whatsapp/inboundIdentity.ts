import prisma from '../../db/prisma';

export interface RegisteredWhatsAppUser {
  userId: number;
  connectionId: number;
  displayName: string | null;
  userName: string | null;
  clientNumber: string;
  department: string | null;
}

/** One canonical phone matcher for activity, transcription preferences and Brain. */
export function whatsappPhoneVariants(input: string): string[] {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  if (!digits) return [];
  const local = `0${digits.startsWith('92') ? digits.slice(2) : digits}`;
  return [...new Set([input, digits, `+${digits}`, local].filter(Boolean))];
}

export async function resolveRegisteredWhatsAppUser(
  clientNumber: string,
  fromNumber: string,
): Promise<RegisteredWhatsAppUser | null> {
  const variants = whatsappPhoneVariants(fromNumber);
  if (!variants.length) return null;
  while (variants.length < 4) variants.push(variants[variants.length - 1]!);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT wc.user_id, wc.id AS connection_id, wc.display_name,
            u.name AS user_name, u.client_number, u.department
       FROM whatsapp_connections wc
       JOIN users u ON u.id = wc.user_id
      WHERE u.client_number = $1
        AND wc.status = 'active'
        AND u.is_active = TRUE
        AND wc.phone_number IN ($2, $3, $4, $5)
      ORDER BY CASE WHEN wc.phone_number = $2 THEN 0 ELSE 1 END, wc.id
      LIMIT 1`,
    clientNumber, variants[0], variants[1], variants[2], variants[3],
  );
  if (!rows.length) return null;
  return {
    userId: Number(rows[0].user_id),
    connectionId: Number(rows[0].connection_id),
    displayName: rows[0].display_name ?? null,
    userName: rows[0].user_name ?? null,
    clientNumber: rows[0].client_number,
    department: rows[0].department ?? null,
  };
}
