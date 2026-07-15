import prisma from '../db/prisma';
import { google } from 'googleapis';
import { decrypt } from '../services/configService';

async function main() {
  const u = await prisma.user.findFirst({ where: { email: 'haseeb@tmcltd.ai' } });
  if (!u) throw new Error('no haseeb');
  const uc = await prisma.userConnector.findFirst({
    where: { userId: u.id, connectorType: { slug: 'gmail' } },
    include: { connectorType: true },
  });
  if (!uc) throw new Error('no gmail connector');
  const cfg = uc.config as any;
  const clientId = (cfg.clientId && await decrypt(cfg.clientId).catch(() => cfg.clientId)) || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = (cfg.clientSecret && await decrypt(cfg.clientSecret).catch(() => cfg.clientSecret)) || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = cfg.refreshToken ? await decrypt(cfg.refreshToken) : null;
  if (!refreshToken) throw new Error('no refresh token');

  const oauth = new google.auth.OAuth2(clientId, clientSecret);
  oauth.setCredentials({ refresh_token: refreshToken });

  const tasks = google.tasks({ version: 'v1', auth: oauth });
  try {
    const r = await tasks.tasklists.list({ maxResults: 1 });
    console.log('OK', JSON.stringify(r.data, null, 2));
  } catch (e: any) {
    console.log('STATUS', e.response?.status);
    console.log('BODY', JSON.stringify(e.response?.data ?? { message: e.message }, null, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch(e => { console.error(e); process.exit(1); });
