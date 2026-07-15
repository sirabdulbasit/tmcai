import prisma from '../db/prisma';

/**
 * LearningService — AI self-learning from user behavior.
 *
 * Tracks 4 categories per user:
 *
 * 1. response_format — how user prefers responses (tables, bullets, detailed, brief)
 *    Learned from: thumbs up/down on different response formats
 *
 * 2. topic_interest — what topics they ask about most
 *    Learned from: query frequency per topic (projects, sales, HR, etc.)
 *
 * 3. communication_style — how the user communicates
 *    Learned from: message analysis (formal, casual, brief, detailed)
 *
 * 4. time_pattern — when user is most active
 *    Learned from: query timestamps
 */

// ─── Track a learning signal ───────────────────────────────────

export async function trackLearning(
  clientNumber: string,
  userId: number,
  category: string,
  key: string,
  value: string,
  scoreBoost = 1.0
): Promise<void> {
  try {
    // Upsert: increment occurrences, boost score, update last_seen
    await prisma.$executeRawUnsafe(`
      INSERT INTO user_learning (client_number, user_id, category, key, value, score, occurrences, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
      ON CONFLICT (user_id, category, key)
      DO UPDATE SET
        score = user_learning.score + $6,
        occurrences = user_learning.occurrences + 1,
        value = $5,
        last_seen_at = NOW()
    `, clientNumber, userId, category, key, value, scoreBoost);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn('[learning] swallowed at recordLearning upsert:', m.slice(0, 240));
  }
}

// ─── Get learned preferences for a user ────────────────────────

export async function getUserLearnings(userId: number): Promise<string[]> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(`
      SELECT category, key, value, score, occurrences
      FROM user_learning
      WHERE user_id = $1 AND score > 0.5
      ORDER BY score DESC
      LIMIT 15
    `, userId);

    if (rows.length === 0) return [];

    return rows.map(r =>
      `[${r.category}] ${r.key}: ${r.value} (confidence: ${r.score.toFixed(1)}, seen ${r.occurrences}x)`
    );
  } catch {
    return [];
  }
}

// ─── Analyze and learn from a user message ─────────────────────

export async function learnFromMessage(
  clientNumber: string,
  userId: number,
  message: string,
  intentType: string
): Promise<void> {
  // 1. Track topic interest
  const topicMap: Record<string, string> = {
    dashboard: 'visual_dashboards',
    list: 'data_lists',
    quick_answer: 'quick_facts',
    detailed_analysis: 'deep_analysis',
    comparison: 'comparisons',
    export: 'data_exports',
  };
  if (topicMap[intentType]) {
    await trackLearning(clientNumber, userId, 'topic_interest', topicMap[intentType], intentType);
  }

  // 2. Track communication style
  const wordCount = message.split(/\s+/).length;
  if (wordCount <= 5) {
    await trackLearning(clientNumber, userId, 'communication_style', 'brevity', 'brief');
  } else if (wordCount > 20) {
    await trackLearning(clientNumber, userId, 'communication_style', 'verbosity', 'detailed');
  }

  const hasSlang = /\b(yo|yaar|bro|btw|lol|haha|pls|thx)\b/i.test(message);
  if (hasSlang) {
    await trackLearning(clientNumber, userId, 'communication_style', 'tone', 'casual');
  }
  const hasFormal = /\b(kindly|please provide|could you|would you|regarding|pursuant)\b/i.test(message);
  if (hasFormal) {
    await trackLearning(clientNumber, userId, 'communication_style', 'tone', 'formal');
  }

  // 3. Track time pattern
  const hour = new Date().getHours();
  const period = hour < 9 ? 'early_morning' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  await trackLearning(clientNumber, userId, 'time_pattern', period, `active_at_${hour}h`);

  // 4. Track specific data topics from message content
  const lower = message.toLowerCase();
  if (/project|status|progress|risk|milestone|delivery/.test(lower)) {
    await trackLearning(clientNumber, userId, 'topic_interest', 'projects', 'projects');
  }
  if (/sales|revenue|deal|pipeline|client|account/.test(lower)) {
    await trackLearning(clientNumber, userId, 'topic_interest', 'sales', 'sales');
  }
  if (/employee|hr|team|org|hierarchy|department/.test(lower)) {
    await trackLearning(clientNumber, userId, 'topic_interest', 'hr_people', 'hr');
  }
}

// ─── Learn from feedback ───────────────────────────────────────

export async function learnFromFeedback(
  clientNumber: string,
  userId: number,
  rating: string,
  intentType: string,
  responseLength: number
): Promise<void> {
  // If user liked a response format, boost it
  const boost = rating === 'up' ? 1.0 : -0.5;

  // Track format preference based on what was liked/disliked
  if (intentType === 'dashboard') {
    await trackLearning(clientNumber, userId, 'response_format', 'widgets', 'dashboard_widget', boost);
  } else if (intentType === 'list') {
    await trackLearning(clientNumber, userId, 'response_format', 'tables', 'table_format', boost);
  } else if (intentType === 'quick_answer') {
    await trackLearning(clientNumber, userId, 'response_format', 'brief', 'brief_answer', boost);
  } else {
    await trackLearning(clientNumber, userId, 'response_format', 'detailed', 'detailed_analysis', boost);
  }

  // Track response length preference
  if (rating === 'up') {
    const lengthPref = responseLength < 200 ? 'short' : responseLength < 1000 ? 'medium' : 'long';
    await trackLearning(clientNumber, userId, 'response_format', 'preferred_length', lengthPref, boost);
  }
}
