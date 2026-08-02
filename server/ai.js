const Anthropic = require('@anthropic-ai/sdk');
const { APP_GUIDE } = require('./appGuide');

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
    "SELECT id, displayName, title, role, managerId FROM users ORDER BY displayName"
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

  // Login activity: last 30 days per user (count + most recent login).
  const twoWeeksAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const loginActivity = db.prepare(`
    SELECT ll.userId, u.displayName AS userName, u.title,
           COUNT(*) AS loginCount,
           MAX(ll.loginAt) AS lastLogin
    FROM login_logs ll JOIN users u ON u.id = ll.userId
    WHERE ll.loginAt >= ?
    GROUP BY ll.userId
    ORDER BY loginCount DESC
  `).all(twoWeeksAgo);

  return { users, tasks, checkins, funding, loginActivity, today };
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
      model: 'claude-haiku-4-5',
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

// Tool the assistant uses to turn a pasted / dictated task list into a
// structured draft. The server never creates tasks from this directly — the
// draft is shown to the admin as an interactive card and only created when
// they confirm.
const PROPOSE_TASKS_TOOL = {
  name: 'propose_tasks',
  description: 'Draft a batch of tasks to assign to board members. Use this whenever the admin gives you one or more tasks to create or assign — including a big pasted list covering many people. Split each item into a short actionable title and a description carrying all the supporting detail (contacts, phone numbers, emails, deadlines, amounts, context). The admin reviews the draft in the app and confirms before anything is created.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            assigneeUserId: {
              type: ['integer', 'null'],
              description: 'The users.id of the board member this task is for, matched from the DATA SNAPSHOT (match first names, nicknames, and partial names). null if no confident match — the admin will pick the person manually.',
            },
            assigneeName: {
              type: 'string',
              description: 'The person\'s name exactly as the admin wrote it (used as the label when assigneeUserId is null).',
            },
            title: {
              type: 'string',
              description: 'Short, actionable task title (under ~80 characters). Starts with a verb. No trailing period.',
            },
            description: {
              type: 'string',
              description: 'Everything else the assignee needs: context, names, emails, phone numbers, dollar amounts, dates, and why it matters. Empty string only if the admin truly gave no detail beyond the title.',
            },
            dueDate: {
              type: ['string', 'null'],
              description: 'Due date as YYYY-MM-DD, only when the admin gave an explicit date for the task itself. Otherwise null (soft deadlines belong in the description).',
            },
          },
          required: ['assigneeName', 'title', 'description'],
        },
      },
    },
    required: ['tasks'],
  },
};

// Validate + clean a raw tool call from the model into the proposal we store
// and show. Unknown userIds are nulled so the admin picks the person manually.
function sanitizeProposal(input, users) {
  if (!input || !Array.isArray(input.tasks)) return null;
  const validIds = new Set(users.map((u) => u.id));
  const tasks = input.tasks
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      const title = String(t.title || '').trim().slice(0, 300);
      if (!title) return null;
      let assigneeUserId = Number.isInteger(t.assigneeUserId) && validIds.has(t.assigneeUserId) ? t.assigneeUserId : null;
      let dueDate = typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : null;
      return {
        assigneeUserId,
        assigneeName: String(t.assigneeName || '').trim().slice(0, 100),
        title,
        description: String(t.description || '').trim().slice(0, 5000),
        dueDate,
      };
    })
    .filter(Boolean)
    .slice(0, 100);
  if (tasks.length === 0) return null;
  return { status: 'proposed', tasks };
}

// Returns { reply, proposal } — proposal is null for a normal answer, or a
// { status: 'proposed', tasks: [...] } draft when the admin asked to create
// or assign tasks.
async function chatWithAI(db, conversationHistory, userId) {
  if (!anthropic) {
    return { reply: 'AI Assistant is not available — the server administrator needs to set ANTHROPIC_API_KEY.', proposal: null };
  }

  const snapshot = buildTeamSnapshot(db);

  const systemPrompt = `You are an AI assistant for the Club America board leadership at Park City High School. Today's date is ${snapshot.today}.

You have access to the full board management data below, including login activity for the last 30 days. Use it to answer questions accurately, naming real people and tasks when relevant. Be concise and focused on the club's management needs.

TASK CREATION:
When the admin asks you to create or assign tasks — whether it's one task or a giant pasted list covering the whole board — call the propose_tasks tool. Rules:
- Break the input into individual tasks: one task per distinct action item. A paragraph of bullets under one person's name is usually several tasks, not one.
- Title vs description: the title is the short "what to do" (verb-first, under ~80 chars). EVERYTHING else the admin wrote for that item — contact names, emails, phone numbers, dollar amounts, deadlines, reasons, warnings — goes in the description, lightly cleaned up. Never lose detail the admin provided.
- Match each person to a real user in the DATA SNAPSHOT by displayName (first names and partial names count: "Will" matches "Will Haladin"). Use their users.id as assigneeUserId. If nobody matches confidently, set assigneeUserId to null and keep the name they wrote — do NOT guess between two similar names.
- Only set dueDate when the admin gave an explicit calendar date for that task. Approximate dates ("around Sept 8") stay in the description.
- After calling the tool, keep your text reply short: a one-line summary (how many tasks, for whom) plus anything that needs the admin's attention, like names you couldn't match. Do not repeat the full task list in text — the app shows it as a card.

DATA SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}`;

  const messages = conversationHistory.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools: [PROPOSE_TASKS_TOOL],
      messages,
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_tasks');
    const textSoFar = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!toolUse) {
      return { reply: textSoFar || '(no response)', proposal: null };
    }

    const proposal = sanitizeProposal(toolUse.input, snapshot.users);
    if (!proposal) {
      return {
        reply: textSoFar || 'I tried to draft those tasks but could not produce a valid list. Try rephrasing or breaking the list into smaller chunks.',
        proposal: null,
      };
    }

    // Close the tool loop so the model can produce its short confirmation text.
    let closing = '';
    try {
      const followUp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        tools: [PROPOSE_TASKS_TOOL],
        messages: [
          ...messages,
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Draft of ${proposal.tasks.length} task(s) recorded. It is now displayed to the admin as an interactive card where they review, adjust assignees, and click Create. Reply with a brief confirmation only.`,
            }],
          },
        ],
      });
      closing = followUp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    } catch (err) {
      console.error('[AI] chatWithAI follow-up error:', err.message);
    }

    const unmatched = proposal.tasks.filter((t) => !t.assigneeUserId).length;
    const fallback = `Drafted ${proposal.tasks.length} task(s). Review the card below and click Create when it looks right.` +
      (unmatched ? ` ${unmatched} task(s) need an assignee picked manually.` : '');
    const reply = [textSoFar, closing].filter(Boolean).join('\n\n') || fallback;
    return { reply, proposal };
  } catch (err) {
    console.error('[AI] chatWithAI error:', err.message);
    throw err;
  }
}

// How-To assistant: answers questions about HOW TO USE the app, grounded only in
// the curated APP_GUIDE (no private club data). Stateless — the caller passes the
// recent conversation each time.
async function chatWithHowTo(conversationHistory, userRole) {
  if (!anthropic) {
    return 'How-To assistant is not available — the administrator needs to set ANTHROPIC_API_KEY.';
  }

  const systemPrompt = `You are the in-app How-To assistant for the Club America Management app, a board-management web app for a high school club. Your job is to help users understand HOW TO USE the app: where features live, the steps to do something, and who is allowed to do what.

The person asking has the role: ${userRole || 'member'}. Tailor answers to what that role can access.

Rules:
- Answer ONLY using the APP GUIDE below. It describes every tab and how to use it.
- Be concise and practical. Use short numbered steps for "how do I…" questions.
- If something is not covered in the guide, say you're not sure and suggest where in the app to look (e.g. ask an admin, check the Admin Panel). Do not invent features.
- You do NOT have access to private club data (specific people, tasks, numbers). For those, tell admins to use the "AI Assistant" tab.
- Stay on the topic of using this app; politely decline unrelated questions.

APP GUIDE:
${APP_GUIDE}`;

  const messages = conversationHistory.map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text;
  } catch (err) {
    console.error('[AI] chatWithHowTo error:', err.message);
    throw err;
  }
}

module.exports = { analyzeTeamHealth, chatWithAI, chatWithHowTo, aiEnabled };
