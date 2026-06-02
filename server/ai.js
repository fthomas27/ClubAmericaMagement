const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const aiEnabled = !!ANTHROPIC_API_KEY;
let anthropic = null;

if (aiEnabled) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
} else {
  console.warn('[AI] ANTHROPIC_API_KEY not set — AI features are disabled.');
}

function buildTeamSnapshot(db) {
  const today = new Date().toISOString().slice(0, 10);

  const users = db.prepare(
    "SELECT id, displayName, title, role, managerId FROM users WHERE username != 'logistics' ORDER BY displayName"
  ).all();

  const tasks = db.prepare(`
    SELECT t.id, t.userId, t.name, t.status, t.dueDate, t.approvalStatus,
           u.displayName AS ownerName
    FROM tasks t JOIN users u ON u.id = t.userId
    WHERE t.approvalStatus = 'approved'
    ORDER BY t.createdAt DESC
    LIMIT 200
  `).all().map((t) => ({
    ...t,
    overdue: !!(t.dueDate && t.dueDate < today && t.status !== 'Complete'),
  }));

  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const checkins = db.prepare(`
    SELECT wc.userId, wc.weekOf, wc.submittedAt, u.displayName AS userName
    FROM weekly_checkins wc JOIN users u ON u.id = wc.userId
    WHERE wc.weekOf >= ?
    ORDER BY wc.weekOf DESC
  `).all(fourWeeksAgo);

  const funding = db.prepare(`
    SELECT fr.id, fr.title, fr.amount, fr.status, u.displayName AS submitterName
    FROM funding_requests fr JOIN users u ON u.id = fr.submittedById
    ORDER BY fr.createdAt DESC LIMIT 20
  `).all();

  return { users, tasks, checkins, funding, today };
}

async function analyzeTeamHealth(db) {
  if (!anthropic) return [];

  const snapshot = buildTeamSnapshot(db);

  const userTaskMap = {};
  for (const u of snapshot.users) {
    userTaskMap[u.id] = { overdue: 0, notStarted: 0, inProgress: 0, complete: 0 };
  }
  for (const t of snapshot.tasks) {
    if (userTaskMap[t.userId]) {
      if (t.overdue) userTaskMap[t.userId].overdue++;
      if (t.status === 'Not Started') userTaskMap[t.userId].notStarted++;
      else if (t.status === 'In Progress') userTaskMap[t.userId].inProgress++;
      else if (t.status === 'Complete') userTaskMap[t.userId].complete++;
    }
  }

  const checkinSetting = db.prepare('SELECT weeklyCheckinEnabled FROM site_settings WHERE id = 1').get();
  const checkinsActive = !!(checkinSetting && checkinSetting.weeklyCheckinEnabled);

  const userCheckinWeeks = {};
  for (const ci of snapshot.checkins) {
    if (!userCheckinWeeks[ci.userId]) userCheckinWeeks[ci.userId] = [];
    userCheckinWeeks[ci.userId].push(ci.weekOf);
  }

  const memberSummary = snapshot.users
    .filter((u) => u.role !== 'admin')
    .map((u) => ({
      userId: u.id,
      name: u.displayName,
      title: u.title,
      tasks: userTaskMap[u.id] || { overdue: 0, notStarted: 0, inProgress: 0, complete: 0 },
      recentCheckinWeeks: userCheckinWeeks[u.id] || [],
    }));

  const prompt = `Today is ${snapshot.today}. Weekly check-ins are ${checkinsActive ? 'ENABLED' : 'DISABLED'}.

Board member workload summary:
${JSON.stringify(memberSummary, null, 2)}

Flag members who meet ANY of these criteria:
- 1 or more overdue tasks
- Missing check-ins for 2+ consecutive weeks (only when check-ins are ENABLED)
- 5 or more tasks with status "Not Started"

Return ONLY a raw JSON array with no markdown, no code fences, no prose.
Format: [{"userId": 3, "noteContent": "..."}]
Write each note directly to the person (second person), encouraging and brief — one short paragraph.
If nobody needs a note, return: []`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'You are a private productivity assistant for a high school club board. Identify members needing a check-in and write short, encouraging private notes. Return ONLY valid JSON arrays, never prose or markdown.',
      messages: [{ role: 'user', content: prompt }],
    });

    let text = response.content[0].text.trim();
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const notes = JSON.parse(text);
    if (!Array.isArray(notes)) return [];
    return notes.filter((n) => n.userId && n.noteContent);
  } catch (err) {
    console.error('[AI] analyzeTeamHealth error:', err.message);
    return [];
  }
}

async function chatWithAI(db, conversationHistory, userId) {
  if (!anthropic) {
    return 'AI Assistant is not available — the server administrator needs to set ANTHROPIC_API_KEY.';
  }

  const snapshot = buildTeamSnapshot(db);

  const systemPrompt = `You are an AI assistant for the Club America board leadership at Park City High School. Today's date is ${snapshot.today}.

You have access to the full board management data below. Use it to answer questions accurately, naming real people and tasks when relevant. Be concise and focused on the club's management needs.

DATA SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}`;

  const messages = conversationHistory.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text;
  } catch (err) {
    console.error('[AI] chatWithAI error:', err.message);
    throw err;
  }
}

module.exports = { analyzeTeamHealth, chatWithAI, aiEnabled };
