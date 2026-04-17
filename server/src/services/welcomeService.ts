import prisma from '../db/prisma';
import { getProfileMemory } from './memoryService';
import { getUserProfile } from './userProfileService';
import { getCachedSections } from './indexCacheService';
import { streamGemini } from './geminiService';
import { getWelcomeNews } from './newsService';

/**
 * WelcomeService — generates a personalized landing experience.
 *
 * Combines:
 * - User memories (health, personal events)
 * - Weather (from OpenWeatherMap API)
 * - Business data changes (projects, risks, deals)
 * - Actionable suggestions
 */

// ─── Weather ───────────────────────────────────────────────────

const weatherCache = new Map<string, { data: string; ts: number }>();
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// News cache — 15 min
const newsCache = new Map<string, { data: string[]; ts: number }>();
const NEWS_CACHE_TTL = 15 * 60 * 1000;

// Email/Calendar snapshot cache — 10 min (data that changes, but not every second)
const emailSnapshotCache = new Map<number, { data: any; ts: number }>();
const calendarSnapshotCache = new Map<number, { data: any; ts: number }>();
const SNAPSHOT_CACHE_TTL = 10 * 60 * 1000;

export async function getWeather(city: string): Promise<string> {
  // Supports both WeatherAPI.com and OpenWeatherMap
  const weatherApiKey = process.env.WEATHER_API_KEY;
  const openWeatherKey = process.env.OPENWEATHER_API_KEY;

  if (!city) return '';

  // Check weather cache
  const cacheKey = city.toLowerCase();
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WEATHER_CACHE_TTL) return cached.data;

  // Try WeatherAPI.com first (preferred)
  if (weatherApiKey) {
    try {
      const url = `https://api.weatherapi.com/v1/current.json?key=${weatherApiKey}&q=${encodeURIComponent(city)}&aqi=no`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const c = data.current;
        const emoji = getWeatherEmoji(c.condition.code, c.is_day);
        const result = `${emoji} ${Math.round(c.temp_c)}°C, ${c.condition.text} · Feels ${Math.round(c.feelslike_c)}°C`;
        weatherCache.set(cacheKey, { data: result, ts: Date.now() });
        return result;
      }
    } catch {}
  }

  // Fallback to OpenWeatherMap
  if (openWeatherKey) {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${openWeatherKey}&units=metric`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const result = `${Math.round(data.main.temp)}°C (feels ${Math.round(data.main.feels_like)}°C), ${data.weather[0]?.description}, humidity ${data.main.humidity}%`;
        weatherCache.set(cacheKey, { data: result, ts: Date.now() });
        return result;
      }
    } catch {}
  }

  return '';
}

function getWeatherEmoji(code: number, isDay: number): string {
  // WeatherAPI.com condition codes → emoji
  if (code === 1000) return isDay ? '☀️' : '🌙';
  if (code === 1003) return '⛅';
  if (code === 1006 || code === 1009) return '☁️';
  if (code >= 1030 && code <= 1035) return '🌫';
  if (code >= 1063 && code <= 1072) return '🌦';
  if (code >= 1150 && code <= 1201) return '🌧';
  if (code >= 1204 && code <= 1237) return '🌨';
  if (code >= 1240 && code <= 1264) return '🌧';
  if (code >= 1273 && code <= 1282) return '⛈';
  return '🌤';
}

// ─── Data Snapshot ─────────────────────────────────────────────

interface DataSnapshot {
  projectCount: number;
  riskyProjects: string[];
  aheadProjects: string[];
}

function extractDataSnapshot(sections: any[]): DataSnapshot {
  const snapshot: DataSnapshot = { projectCount: 0, riskyProjects: [], aheadProjects: [] };

  // Find the project status section specifically
  const projectSection = sections.find((s: any) =>
    s.headerLower?.includes('project') && s.headerLower?.includes('status')
  );

  if (!projectSection) return snapshot;

  const body = projectSection.body || '';
  const lines = body.split('\n');

  // Count data rows — lines with pipe separators that have a project code (3-4 digit number at start)
  const dataRows = lines.filter((l: string) => {
    const trimmed = l.trim();
    return trimmed.includes('|') && /^\d{3,4}\s*\|/.test(trimmed);
  });
  snapshot.projectCount = dataRows.length;

  // Find rows with risks
  for (const line of dataRows) {
    const lower = line.toLowerCase();
    if (lower.includes('critical') || lower.includes('high')) {
      const parts = line.split('|').map((p: string) => p.trim()).filter(Boolean);
      if (parts.length > 1) snapshot.riskyProjects.push(parts[1]?.slice(0, 40) || '');
    }
    if (lower.includes('ahead')) {
      const parts = line.split('|').map((p: string) => p.trim()).filter(Boolean);
      if (parts.length > 1) snapshot.aheadProjects.push(parts[1]?.slice(0, 40) || '');
    }
  }

  return snapshot;
}

// Welcome-level cache REMOVED — memories must always be fresh
// Weather has its own 10-min cache, news has its own cache
// Only AI personal note runs on each load (with 1.2s timeout)

// ─── Generate Welcome Briefing ─────────────────────────────────

export async function generateWelcomeBriefing(userId: number): Promise<{
  greeting: string;
  aiName: string;
  weather: string;
  memoryNote: string;
  daySnapshot: { icon: string; text: string; query: string; status: string }[];
  newsHeadlines: string[];
  activitySnapshot: string[];
  actions: { label: string; query: string }[];
  emailSnapshot: { unreadCount: number; totalRecent: number; topEmails: { from: string; subject: string; isUnread: boolean }[] };
  calendarSnapshot: { title: string; time: string; location: string }[];
  hasIntegration: boolean;
  adminStats?: { openLogs: number; recurringLogs: number; mtdCost: string; mtdTokens: string; mtdRequests: number };
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, city: true, userType: true, integrationProvider: true, integrationStatus: true, integrationEmail: true },
  });
  if (!user) return { greeting: '', aiName: '', weather: '', memoryNote: '', newsHeadlines: [], daySnapshot: [], activitySnapshot: [], actions: [], emailSnapshot: { unreadCount: 0, totalRecent: 0, topEmails: [] }, calendarSnapshot: [], hasIntegration: false };

  const t0 = Date.now();
  const [profile, profileMemory, recentMsgs] = await Promise.all([
    getUserProfile(userId),
    getProfileMemory(userId),
    prisma.message.findMany({
      where: { conversation: { userId }, role: 'user' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { content: true },
    }),
  ]);
  const recentContext = recentMsgs.map(m => m.content).reverse();

  // Greeting
  const h = new Date().getHours();
  const timeGreeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = user.name.split(' ')[0];

  // Get AI name from profile memory — handles "Name: Jeni", "AI's name is Sonu", "call me Jeni"
  const nameMatch = profileMemory.aiInstructions.match(/(?:name(?:\s+is)?|call\s+me)[:\s]+(\w+)/i);
  const aiName = nameMatch ? nameMatch[1] : '';

  const city = profile?.city || (user as any).city || '';
  const hasMemoryData = profileMemory.userPersonal || profileMemory.activeConcerns;
  // Check both legacy User fields AND new UserConnector for gmail
  let hasIntegration = !!(user.integrationProvider && user.integrationStatus === 'active');
  if (!hasIntegration) {
    try {
      const gmailType = await prisma.connectorType.findUnique({ where: { slug: 'gmail' } });
      if (gmailType) {
        const uc = await prisma.userConnector.findUnique({ where: { userId_connectorTypeId: { userId, connectorTypeId: gmailType.id } } });
        if (uc?.status === 'connected') hasIntegration = true;
      }
    } catch {}
  }

  console.log(`[Welcome] Phase 1 (profile+memory+msgs): ${Date.now() - t0}ms`);
  const t1 = Date.now();
  // ── Run weather, news, and AI note ALL IN PARALLEL ─────
  // Weather has 1.5s timeout — external API can be slow, don't block welcome
  const weatherWithTimeout = city
    ? Promise.race([getWeather(city), new Promise<string>(r => setTimeout(() => r(''), 1500))])
    : Promise.resolve('');

  const [weather, newsHeadlines, memoryNote, emailSnapshot, calendarSnapshot] = await Promise.all([
    weatherWithTimeout,

    // News — disabled for faster welcome screen load
    Promise.resolve([] as string[]),

    // AI personal note — 1.2s timeout (skip if slow, user sees greeting without note)
    (hasMemoryData || hasIntegration) ? Promise.race([
      (async () => {
        try {
          let note = '';
          const notePrompt = 'You are a warm, caring friend. Write ONE natural sentence (max 25 words) to open a conversation.\n' +
            '1. ACTIVE CONCERN → ask about it.\n' +
            '2. RESOLVED → topic closed, skip.\n' +
            '3. If email/calendar is connected, offer to help: "Want me to check your emails or today\'s schedule?"\n' +
            '4. No concerns and no integration → ask something friendly.\n' +
            '5. Never re-ask known facts. Never sound robotic.\n' +
            '6. If nothing to say, return: NONE';
          const noteContext = `Personal: ${profileMemory.userPersonal || '(none)'}\nConcerns: ${profileMemory.activeConcerns || '(none)'}\nEmail connected: ${hasIntegration ? 'yes' : 'no'}\nRecent: ${recentContext.join(' | ') || '(none)'}`;
          await streamGemini(
            notePrompt,
            noteContext,
            (chunk) => { note += chunk; },
            true,
            256,
            true  // disableThinking — REST with thinkingBudget:0
          );
          const trimmed = note.trim();
          return (trimmed && !trimmed.includes('NONE')) ? trimmed : '';
        } catch { return ''; }
      })(),
      new Promise<string>(r => setTimeout(() => r(''), 1200)),
    ]) : Promise.resolve(''),

    // Email snapshot — cached 10 min, 2s timeout
    hasIntegration ? Promise.race([
      (async () => {
        const cached = emailSnapshotCache.get(userId);
        if (cached && Date.now() - cached.ts < SNAPSHOT_CACHE_TTL) return cached.data;
        try {
          const { getInbox } = require('./gmailService');
          const today = new Date();
          const todayStr = `${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
          const { emails } = await getInbox(userId, 10, `after:${todayStr}`);
          const unreadCount = emails.filter((e: any) => e.isUnread).length;
          const result = {
            unreadCount: unreadCount || 0,
            totalRecent: emails.length,
            topEmails: emails.slice(0, 3).map((e: any) => ({
              from: e.from?.replace(/<.*>/, '').trim().split('<')[0].trim() || 'Unknown',
              subject: e.subject || '(no subject)',
              isUnread: e.isUnread,
            })),
          };
          emailSnapshotCache.set(userId, { data: result, ts: Date.now() });
          return result;
        } catch { return { unreadCount: 0, totalRecent: 0, topEmails: [] }; }
      })(),
      new Promise<any>(r => setTimeout(() => r({ unreadCount: 0, totalRecent: 0, topEmails: [] }), 2000)),
    ]) : Promise.resolve({ unreadCount: 0, totalRecent: 0, topEmails: [] }),

    // Calendar snapshot — cached 10 min, 2s timeout
    hasIntegration ? Promise.race([
      (async () => {
        const cached = calendarSnapshotCache.get(userId);
        if (cached && Date.now() - cached.ts < SNAPSHOT_CACHE_TTL) return cached.data;
        try {
          const { getTodayEvents } = require('./calendarService');
          const { events } = await getTodayEvents(userId);
          const result = events.map((e: any) => {
            const loc = (e.location || '').split(';')[0].replace(/https?:\/\/\S+/g, '').trim();
            return {
              title: e.title || '(no title)',
              time: e.isAllDay ? 'All day' : new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
              location: loc || '',
            };
          });
          calendarSnapshotCache.set(userId, { data: result, ts: Date.now() });
          return result;
        } catch { return []; }
      })(),
      new Promise<any[]>(r => setTimeout(() => r([]), 2000)),
    ]) : Promise.resolve([]),
  ]);

  console.log(`[Welcome] Phase 2 (weather+note+email+calendar): ${Date.now() - t1}ms | weather=${weather?'yes':'no'} note=${memoryNote?'yes':'no'} emails=${emailSnapshot.totalRecent} cal=${calendarSnapshot.length}`);
  const t2 = Date.now();
  // Data snapshot (instant — from cache)
  const sections = getCachedSections();
  const snapshot = extractDataSnapshot(sections);
  const highlights: string[] = [];
  if (snapshot.projectCount > 0) highlights.push(`${snapshot.projectCount} active projects`);
  if (snapshot.riskyProjects.length > 0) highlights.push(`${snapshot.riskyProjects.length} with critical/high risks`);
  if (snapshot.aheadProjects.length > 0) highlights.push(`${snapshot.aheadProjects.length} ahead of schedule`);

  // Actions — dynamic based on integration status
  const actions: { label: string; query: string }[] = [];

  if (hasIntegration) {
    actions.push({ label: "Summarize today's emails", query: 'check my emails' });
    actions.push({ label: "Today's schedule", query: "what's on my calendar today?" });
  }

  actions.push({ label: 'Project overview', query: 'show project dashboard' });
  actions.push({ label: 'Sales summary', query: 'give me sales summary' });

  if (!hasIntegration) {
    actions.push({ label: 'Team structure', query: 'show org chart' });
  }

  const daySnapshot: { icon: string; text: string; query: string; status: string }[] = [];

  // Admin stats (logs + token cost) — only for AD/SA
  let adminStats: any = undefined;
  const isAdmin = user.userType === 'SA' || user.userType === 'AD';
  if (isAdmin) {
    try {
      const [logCounts, costData]: any[] = await Promise.all([
        prisma.$queryRawUnsafe("SELECT COUNT(*) FILTER (WHERE status = 'open') as open, COUNT(*) FILTER (WHERE status = 'recurring') as recurring FROM system_logs"),
        prisma.$queryRawUnsafe("SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens, COALESCE(SUM(request_count), 0) as requests FROM token_usage WHERE date >= date_trunc('month', CURRENT_DATE)"),
      ]);
      const fmtNum = (n: number) => n > 1000000 ? (n/1000000).toFixed(1)+'M' : n > 1000 ? (n/1000).toFixed(1)+'K' : String(n);
      adminStats = {
        openLogs: Number(logCounts[0]?.open || 0),
        recurringLogs: Number(logCounts[0]?.recurring || 0),
        mtdCost: Number(costData[0]?.cost || 0).toFixed(2),
        mtdTokens: fmtNum(Number(costData[0]?.tokens || 0)),
        mtdInputTokens: fmtNum(Number(costData[0]?.input_tokens || 0)),
        mtdOutputTokens: fmtNum(Number(costData[0]?.output_tokens || 0)),
        mtdRequests: Number(costData[0]?.requests || 0),
      };
    } catch { /* skip admin stats if query fails */ }
  }

  const result = {
    greeting: `${timeGreeting}, ${firstName}!`,
    aiName: aiName || '',
    weather: weather ? weather : '',
    memoryNote,
    newsHeadlines,
    daySnapshot,
    activitySnapshot: highlights,
    actions,
    emailSnapshot: emailSnapshot || { unreadCount: 0, totalRecent: 0, topEmails: [] },
    calendarSnapshot: calendarSnapshot || [],
    hasIntegration: !!hasIntegration,
    adminStats,
  };

  console.log(`[Welcome] Phase 3 (snapshot+admin): ${Date.now() - t2}ms | TOTAL: ${Date.now() - t0}ms`);
  return result;
}
