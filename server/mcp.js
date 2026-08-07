// ---- Remote MCP server ------------------------------------------------------
// Exposes the board-management data as MCP (Model Context Protocol) tools over
// Streamable HTTP, so an external Claude chat (claude.ai custom connector,
// Claude Desktop, Claude Code) can read and manage the site directly: tasks,
// volunteer events, meetings, speaker events, the merch shop, roster, funding,
// announcements, and more.
//
// Security model: the endpoint is mounted at /mcp/<MCP_SECRET>. The secret is
// a long random string set via the MCP_SECRET env var; only someone who knows
// the full URL can call the tools. Every action is performed "as" a designated
// board account (MCP_ACTOR_USERNAME, defaulting to the first admin) so the
// existing notification + approval-log plumbing attributes changes sensibly.
// When MCP_SECRET is unset the whole feature quietly disables itself.
const crypto = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { db } = require('./db');

const MCP_SECRET = process.env.MCP_SECRET || '';
const mcpEnabled = MCP_SECRET.length >= 16;

const STATUSES = ['Not Started', 'In Progress', 'Complete'];
const GRADES = ['9', '10', '11', '12'];

// Same pipeline rules the roster UI enforces (see index.js ROSTER_TRANSITIONS).
const ROSTER_TRANSITIONS = {
  Pending:   ['Onboarded', 'Prospect', 'Declined'],
  Prospect:  ['Contacted', 'Declined'],
  Contacted: ['Onboarded', 'Declined', 'Prospect'],
  Onboarded: ['Contacted', 'Declined', 'Inactive'],
  Declined:  ['Prospect', 'Contacted'],
  Inactive:  ['Onboarded', 'Declined'],
};

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

// The board account MCP actions run as. Assignments, approvals, and audit-log
// entries carry this user's name so the rest of the app reads naturally.
function resolveActor() {
  const wanted = String(process.env.MCP_ACTOR_USERNAME || '').toLowerCase().trim();
  if (wanted) {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(wanted);
    if (u) return u;
  }
  return db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
}

function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Every tool returns JSON as text content; errors become isError results so
// the model can read the reason and correct itself instead of failing the call.
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
class ToolError extends Error {}
const reject = (msg) => { throw new ToolError(msg); };

function buildServer(helpers) {
  const { pushNotification, logApproval, ensureStripeProduct } = helpers;
  const server = new McpServer({ name: 'club-america-management', version: '1.0.0' });

  // registerTool wrapper: catches ToolError (and anything else) into an
  // isError result instead of a protocol-level failure.
  function tool(name, description, shape, fn) {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      try {
        return ok(await fn(args || {}));
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(`[mcp] ${name} failed:`, e);
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    });
  }

  const id = (desc) => z.number().int().describe(desc);

  // ---- Overview -------------------------------------------------------------

  tool('get_club_snapshot',
    'One-call overview of the whole club: board size, task health, pending approvals, funding/reimbursements awaiting review, open shop orders, roster pipeline counts, upcoming volunteer events and meetings, and unhandled public submissions. Call this first to orient yourself.',
    {},
    () => {
      const today = new Date().toISOString().slice(0, 10);
      const one = (sql, ...p) => db.prepare(sql).get(...p);
      return {
        today,
        boardMembers: one('SELECT COUNT(*) AS n FROM users').n,
        tasks: {
          open: one("SELECT COUNT(*) AS n FROM tasks WHERE status != 'Complete' AND approvalStatus = 'approved'").n,
          overdue: one("SELECT COUNT(*) AS n FROM tasks WHERE approvalStatus = 'approved' AND status != 'Complete' AND dueDate IS NOT NULL AND dueDate < ?", today).n,
          pendingApproval: one("SELECT COUNT(*) AS n FROM tasks WHERE approvalStatus = 'pending'").n,
        },
        funding: { pending: one("SELECT COUNT(*) AS n FROM funding_requests WHERE status = 'pending'").n },
        reimbursements: { pending: one("SELECT COUNT(*) AS n FROM reimbursements WHERE status = 'pending'").n },
        shopOrders: {
          pendingFulfillment: one("SELECT COUNT(*) AS n FROM merch_orders WHERE fulfillmentStatus = 'pending'").n,
          needsReview: one("SELECT COUNT(*) AS n FROM merch_orders WHERE fulfillmentStatus = 'needs_review'").n,
        },
        roster: db.prepare('SELECT status, COUNT(*) AS n FROM roster_members GROUP BY status').all(),
        upcomingVolunteerEvents: db.prepare('SELECT id, title, startDate, location FROM volunteer_events WHERE startDate >= ? ORDER BY startDate LIMIT 5').all(today),
        upcomingMeetings: db.prepare('SELECT id, title, meetingDate FROM meetings WHERE meetingDate >= ? ORDER BY meetingDate LIMIT 5').all(today),
        unhandledSubmissions: one('SELECT COUNT(*) AS n FROM submissions WHERE handled = 0').n,
        upcomingSpeakerEvents: db.prepare("SELECT id, title, speakerName, eventDate, status FROM speaker_events WHERE status != 'Completed' ORDER BY eventDate LIMIT 5").all(),
      };
    });

  tool('list_board_members',
    'List every board member account: id, name, title, role (admin/manager/member), email, grade, and manager. Use the ids as assigneeUserId / userId in other tools.',
    {},
    () => db.prepare(`
      SELECT u.id, u.displayName, u.title, u.role, u.email, u.grade, u.managerId,
             m.displayName AS managerName
      FROM users u LEFT JOIN users m ON m.id = u.managerId
      ORDER BY u.displayName
    `).all());

  // ---- Tasks ----------------------------------------------------------------

  tool('list_tasks',
    'List tasks, newest first. Filter by assignee, status, or overdue-only.',
    {
      userId: id('Only tasks assigned to this user id').optional(),
      status: z.enum(STATUSES).optional(),
      overdueOnly: z.boolean().optional().describe('Only incomplete tasks past their due date'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100)'),
    },
    ({ userId, status, overdueOnly, limit }) => {
      const today = new Date().toISOString().slice(0, 10);
      let sql = `SELECT t.id, t.userId, u.displayName AS assignee, t.name, t.description, t.status,
                        t.dueDate, t.approvalStatus, t.createdAt
                 FROM tasks t JOIN users u ON u.id = t.userId WHERE 1=1`;
      const p = [];
      if (userId) { sql += ' AND t.userId = ?'; p.push(userId); }
      if (status) { sql += ' AND t.status = ?'; p.push(status); }
      if (overdueOnly) { sql += " AND t.status != 'Complete' AND t.dueDate IS NOT NULL AND t.dueDate < ?"; p.push(today); }
      sql += ' ORDER BY t.createdAt DESC LIMIT ?'; p.push(limit || 100);
      return db.prepare(sql).all(...p);
    });

  tool('create_task',
    'Create and directly assign a task to a board member (assigned as the site\'s admin, so no approval step). The assignee gets an in-app + Telegram notification.',
    {
      assigneeUserId: id('users.id of the board member this task is for'),
      name: z.string().min(1).max(300).describe('Short, actionable task title'),
      description: z.string().max(5000).optional().describe('All supporting detail: contacts, amounts, context'),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date YYYY-MM-DD'),
    },
    ({ assigneeUserId, name, description, dueDate }) => {
      const actor = resolveActor();
      const owner = getUser(assigneeUserId);
      if (!owner) reject(`No user with id ${assigneeUserId} — call list_board_members for valid ids`);
      const info = db.prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus)
                               VALUES (?, ?, ?, ?, 'Not Started', ?, 'approved')`)
        .run(owner.id, name.trim(), (description || '').trim(), dueDate || null, actor ? actor.id : null);
      if (!actor || owner.id !== actor.id) {
        pushNotification(owner.id, `${actor ? actor.displayName : 'Claude Assistant'} assigned you a task: "${name.trim()}"`, 'tasks', 'task');
      }
      return { created: db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) };
    });

  tool('bulk_create_tasks',
    'Create and directly assign many tasks in a single call (assigned as the site\'s admin, so no approval step). Prefer this over calling create_task repeatedly — it\'s one round trip instead of many, and each assignee gets a single summary notification instead of one per task.',
    {
      tasks: z.array(z.object({
        assigneeUserId: id('users.id of the board member this task is for'),
        name: z.string().min(1).max(300).describe('Short, actionable task title'),
        description: z.string().max(5000).optional().describe('All supporting detail: contacts, amounts, context'),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date YYYY-MM-DD'),
      })).min(1).max(200).describe('Up to 200 tasks to create in one call'),
    },
    ({ tasks }) => {
      const actor = resolveActor();
      const created = [];
      const errors = [];
      const byAssignee = new Map();
      db.transaction(() => {
        tasks.forEach((t, index) => {
          const owner = getUser(t.assigneeUserId);
          if (!owner) { errors.push({ index, name: t.name, error: `No user with id ${t.assigneeUserId} — call list_board_members for valid ids` }); return; }
          const info = db.prepare(`INSERT INTO tasks (userId, name, description, dueDate, status, assignedById, approvalStatus)
                                   VALUES (?, ?, ?, ?, 'Not Started', ?, 'approved')`)
            .run(owner.id, t.name.trim(), (t.description || '').trim(), t.dueDate || null, actor ? actor.id : null);
          created.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
          if (!actor || owner.id !== actor.id) {
            if (!byAssignee.has(owner.id)) byAssignee.set(owner.id, { owner, names: [] });
            byAssignee.get(owner.id).names.push(t.name.trim());
          }
        });
      })();
      for (const { owner, names } of byAssignee.values()) {
        const who = actor ? actor.displayName : 'Claude Assistant';
        const msg = names.length === 1
          ? `${who} assigned you a task: "${names[0]}"`
          : `${who} assigned you ${names.length} new tasks: ${names.slice(0, 5).join(', ')}${names.length > 5 ? `, +${names.length - 5} more` : ''}`;
        pushNotification(owner.id, msg, 'tasks', 'task');
      }
      return { createdCount: created.length, created, errors };
    });

  tool('update_task',
    'Update a task\'s title, description, status, or due date.',
    {
      taskId: id('tasks.id'),
      name: z.string().min(1).max(300).optional(),
      description: z.string().max(5000).optional(),
      status: z.enum(STATUSES).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('YYYY-MM-DD, or null to clear'),
    },
    ({ taskId, name, description, status, dueDate }) => {
      const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!t) reject(`Task ${taskId} not found`);
      db.prepare(`UPDATE tasks SET name = COALESCE(?, name), description = COALESCE(?, description),
                  status = COALESCE(?, status), dueDate = CASE WHEN ? THEN ? ELSE dueDate END WHERE id = ?`)
        .run(name ?? null, description ?? null, status ?? null,
             dueDate !== undefined ? 1 : 0, dueDate ?? null, taskId);
      return { updated: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) };
    });

  tool('delete_task',
    'Permanently delete a task (and its comments/subtask links).',
    { taskId: id('tasks.id') },
    ({ taskId }) => {
      const t = db.prepare('SELECT id, name FROM tasks WHERE id = ?').get(taskId);
      if (!t) reject(`Task ${taskId} not found`);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      return { deleted: t };
    });

  tool('bulk_delete_tasks',
    'Permanently delete many tasks in a single call (and their comments/subtask links). Prefer this over calling delete_task repeatedly — it\'s one round trip instead of many.',
    { taskIds: z.array(id('tasks.id')).min(1).max(500).describe('Up to 500 task ids to delete in one call') },
    ({ taskIds }) => {
      const deleted = [];
      const notFound = [];
      db.transaction(() => {
        for (const taskId of taskIds) {
          const t = db.prepare('SELECT id, name FROM tasks WHERE id = ?').get(taskId);
          if (!t) { notFound.push(taskId); continue; }
          db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
          deleted.push(t);
        }
      })();
      return { deletedCount: deleted.length, deleted, notFound };
    });

  tool('list_pending_approvals',
    'List tasks waiting for a manager\'s approval before they land on the assignee\'s board.',
    {},
    () => db.prepare(`
      SELECT t.id, t.name, t.dueDate, u.displayName AS assignee,
             a.displayName AS proposedBy, ap.displayName AS approver, t.createdAt
      FROM tasks t
      JOIN users u ON u.id = t.userId
      LEFT JOIN users a ON a.id = t.assignedById
      LEFT JOIN users ap ON ap.id = t.approverId
      WHERE t.approvalStatus = 'pending' ORDER BY t.createdAt DESC
    `).all());

  tool('approve_task',
    'Approve a pending task assignment (acts as admin). Notifies the assignee and the original proposer.',
    { taskId: id('tasks.id of a pending task') },
    ({ taskId }) => {
      const actor = resolveActor();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!task) reject(`Task ${taskId} not found`);
      if (task.approvalStatus !== 'pending') reject('Task is not pending approval');
      db.transaction(() => {
        db.prepare("UPDATE tasks SET approvalStatus = 'approved' WHERE id = ?").run(task.id);
        logApproval('task', task.id, 'approved', actor, task.name);
      })();
      const owner = getUser(task.userId);
      if (owner) pushNotification(owner.id, `Your task "${task.name}" was approved by ${actor ? actor.displayName : 'Claude Assistant'}`, 'tasks', 'task');
      if (task.assignedById && owner && task.assignedById !== owner.id) {
        pushNotification(task.assignedById, `${actor ? actor.displayName : 'Claude Assistant'} approved the task "${task.name}" you assigned to ${owner.displayName}`, 'tasks', 'task');
      }
      return { approved: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) };
    });

  tool('reject_task',
    'Reject a pending task assignment (acts as admin). Notifies the proposer.',
    { taskId: id('tasks.id of a pending task') },
    ({ taskId }) => {
      const actor = resolveActor();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!task) reject(`Task ${taskId} not found`);
      if (task.approvalStatus !== 'pending') reject('Task is not pending approval');
      db.transaction(() => {
        db.prepare("UPDATE tasks SET approvalStatus = 'rejected' WHERE id = ?").run(task.id);
        logApproval('task', task.id, 'rejected', actor, task.name);
      })();
      if (task.assignedById) {
        pushNotification(task.assignedById, `${actor ? actor.displayName : 'Claude Assistant'} rejected the task "${task.name}" you proposed`, 'tasks', 'task');
      }
      return { rejected: { id: task.id, name: task.name } };
    });

  // ---- Volunteer events -----------------------------------------------------

  tool('list_volunteer_events',
    'List volunteer events with their roles, caps, and confirmed/waitlisted signup counts.',
    { includePast: z.boolean().optional().describe('Include events whose start date already passed (default false)') },
    ({ includePast }) => {
      const today = new Date().toISOString().slice(0, 10);
      const events = includePast
        ? db.prepare('SELECT * FROM volunteer_events ORDER BY startDate DESC').all()
        : db.prepare('SELECT * FROM volunteer_events WHERE startDate >= ? ORDER BY startDate').all(today);
      return events.map((ev) => {
        const roles = db.prepare('SELECT id, roleName, cap FROM volunteer_roles WHERE eventId = ? ORDER BY id').all(ev.id).map((r) => ({
          ...r,
          confirmed: db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'confirmed'").get(r.id).n,
          waitlisted: db.prepare("SELECT COUNT(*) AS n FROM volunteer_signups WHERE roleId = ? AND status = 'waitlisted'").get(r.id).n,
        }));
        const totals = db.prepare(`SELECT SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                                          SUM(CASE WHEN status = 'waitlisted' THEN 1 ELSE 0 END) AS waitlisted
                                   FROM volunteer_signups WHERE eventId = ?`).get(ev.id);
        return { ...ev, volunteersEnabled: !!ev.volunteersEnabled, roles,
                 confirmedTotal: totals.confirmed || 0, waitlistedTotal: totals.waitlisted || 0 };
      });
    });

  tool('create_volunteer_event',
    'Create a volunteer event, optionally with roles/shifts (each with a signup cap; cap 0 = unlimited). The public signup page is /volunteer/<id>.',
    {
      title: z.string().min(1).max(200),
      startDate: z.string().min(4).max(30).describe('Event date/time, e.g. 2026-09-14 or 2026-09-14T10:00'),
      location: z.string().max(200).optional(),
      roles: z.array(z.object({
        roleName: z.string().min(1).max(100),
        cap: z.number().int().min(0).describe('Max confirmed signups; 0 = unlimited'),
      })).optional(),
    },
    ({ title, startDate, location, roles }) => {
      const actor = resolveActor();
      const info = db.prepare('INSERT INTO volunteer_events (icalUid, title, location, startDate, createdById) VALUES (?, ?, ?, ?, ?)')
        .run('mcp-' + crypto.randomUUID(), title.trim(), (location || '').trim(), startDate.trim(), actor ? actor.id : null);
      const eventId = info.lastInsertRowid;
      for (const r of roles || []) {
        db.prepare('INSERT INTO volunteer_roles (eventId, roleName, cap) VALUES (?, ?, ?)')
          .run(eventId, r.roleName.trim().slice(0, 100), Math.max(0, r.cap));
      }
      return { created: { id: eventId, title: title.trim(), startDate, signupPath: `/volunteer/${eventId}` } };
    });

  tool('update_volunteer_event',
    'Update a volunteer event\'s title, location, start date, or toggle signups on/off.',
    {
      eventId: id('volunteer_events.id'),
      title: z.string().min(1).max(200).optional(),
      location: z.string().max(200).optional(),
      startDate: z.string().min(4).max(30).optional(),
      volunteersEnabled: z.boolean().optional(),
    },
    ({ eventId, title, location, startDate, volunteersEnabled }) => {
      const ev = db.prepare('SELECT * FROM volunteer_events WHERE id = ?').get(eventId);
      if (!ev) reject(`Volunteer event ${eventId} not found`);
      db.prepare(`UPDATE volunteer_events SET title = COALESCE(?, title), location = COALESCE(?, location),
                  startDate = COALESCE(?, startDate), volunteersEnabled = COALESCE(?, volunteersEnabled) WHERE id = ?`)
        .run(title ?? null, location ?? null, startDate ?? null,
             volunteersEnabled !== undefined ? (volunteersEnabled ? 1 : 0) : null, eventId);
      return { updated: db.prepare('SELECT * FROM volunteer_events WHERE id = ?').get(eventId) };
    });

  tool('delete_volunteer_event',
    'Delete a volunteer event and all of its roles and signups.',
    { eventId: id('volunteer_events.id') },
    ({ eventId }) => {
      const ev = db.prepare('SELECT id, title FROM volunteer_events WHERE id = ?').get(eventId);
      if (!ev) reject(`Volunteer event ${eventId} not found`);
      db.prepare('DELETE FROM volunteer_events WHERE id = ?').run(eventId);
      return { deleted: ev };
    });

  tool('add_volunteer_role',
    'Add a role/shift to an existing volunteer event.',
    { eventId: id('volunteer_events.id'), roleName: z.string().min(1).max(100), cap: z.number().int().min(0).describe('0 = unlimited') },
    ({ eventId, roleName, cap }) => {
      const ev = db.prepare('SELECT id FROM volunteer_events WHERE id = ?').get(eventId);
      if (!ev) reject(`Volunteer event ${eventId} not found`);
      const info = db.prepare('INSERT INTO volunteer_roles (eventId, roleName, cap) VALUES (?, ?, ?)')
        .run(eventId, roleName.trim(), Math.max(0, cap));
      return { created: { id: info.lastInsertRowid, eventId, roleName: roleName.trim(), cap } };
    });

  tool('update_volunteer_role',
    'Rename a volunteer role or change its signup cap.',
    { roleId: id('volunteer_roles.id'), roleName: z.string().min(1).max(100).optional(), cap: z.number().int().min(0).optional() },
    ({ roleId, roleName, cap }) => {
      const role = db.prepare('SELECT * FROM volunteer_roles WHERE id = ?').get(roleId);
      if (!role) reject(`Volunteer role ${roleId} not found`);
      db.prepare('UPDATE volunteer_roles SET roleName = COALESCE(?, roleName), cap = COALESCE(?, cap) WHERE id = ?')
        .run(roleName ?? null, cap ?? null, roleId);
      return { updated: db.prepare('SELECT * FROM volunteer_roles WHERE id = ?').get(roleId) };
    });

  tool('list_volunteer_signups',
    'List everyone signed up for a volunteer event, with role, status, and roster match.',
    { eventId: id('volunteer_events.id') },
    ({ eventId }) => db.prepare(`
      SELECT vs.id, vs.name, vs.phone, vs.email, vs.grade, vs.status, vs.createdAt,
             vr.roleName, rm.firstName || ' ' || rm.lastName AS rosterMatch
      FROM volunteer_signups vs
      LEFT JOIN volunteer_roles vr ON vr.id = vs.roleId
      LEFT JOIN roster_members rm ON rm.id = vs.matchedRosterId
      WHERE vs.eventId = ? ORDER BY vs.createdAt
    `).all(eventId));

  tool('remove_volunteer_signup',
    'Remove one signup from a volunteer event.',
    { signupId: id('volunteer_signups.id') },
    ({ signupId }) => {
      const s = db.prepare('SELECT id, name FROM volunteer_signups WHERE id = ?').get(signupId);
      if (!s) reject(`Signup ${signupId} not found`);
      db.prepare('DELETE FROM volunteer_signups WHERE id = ?').run(signupId);
      return { deleted: s };
    });

  // ---- Meetings -------------------------------------------------------------

  tool('list_meetings',
    'List board meetings (title, date, agenda/minutes links, notes), newest first.',
    { limit: z.number().int().min(1).max(200).optional() },
    ({ limit }) => db.prepare('SELECT * FROM meetings ORDER BY meetingDate DESC LIMIT ?').all(limit || 50));

  tool('create_meeting',
    'Create a board meeting record.',
    {
      title: z.string().min(1).max(200),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).describe('YYYY-MM-DD'),
      agendaUrl: z.string().max(500).optional(),
      minutesUrl: z.string().max(500).optional(),
      notes: z.string().max(5000).optional(),
    },
    ({ title, meetingDate, agendaUrl, minutesUrl, notes }) => {
      const actor = resolveActor();
      const info = db.prepare('INSERT INTO meetings (title, meetingDate, agendaUrl, minutesUrl, notes, createdById) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title.trim(), meetingDate, agendaUrl || '', minutesUrl || '', notes || '', actor ? actor.id : null);
      return { created: db.prepare('SELECT * FROM meetings WHERE id = ?').get(info.lastInsertRowid) };
    });

  tool('update_meeting',
    'Update a meeting\'s title, date, agenda/minutes links, or notes.',
    {
      meetingId: id('meetings.id'),
      title: z.string().min(1).max(200).optional(),
      meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
      agendaUrl: z.string().max(500).optional(),
      minutesUrl: z.string().max(500).optional(),
      notes: z.string().max(5000).optional(),
    },
    ({ meetingId, title, meetingDate, agendaUrl, minutesUrl, notes }) => {
      const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
      if (!m) reject(`Meeting ${meetingId} not found`);
      db.prepare(`UPDATE meetings SET title = COALESCE(?, title), meetingDate = COALESCE(?, meetingDate),
                  agendaUrl = COALESCE(?, agendaUrl), minutesUrl = COALESCE(?, minutesUrl), notes = COALESCE(?, notes) WHERE id = ?`)
        .run(title ?? null, meetingDate ?? null, agendaUrl ?? null, minutesUrl ?? null, notes ?? null, meetingId);
      return { updated: db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) };
    });

  tool('delete_meeting',
    'Delete a meeting record (and its action items).',
    { meetingId: id('meetings.id') },
    ({ meetingId }) => {
      const m = db.prepare('SELECT id, title FROM meetings WHERE id = ?').get(meetingId);
      if (!m) reject(`Meeting ${meetingId} not found`);
      db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
      return { deleted: m };
    });

  // ---- Speaker events (board events) ---------------------------------------

  tool('list_speaker_events',
    'List speaker/board events with their pre-event checklist (room, promotion, logistics, TPUSA) and status.',
    {},
    () => db.prepare('SELECT * FROM speaker_events ORDER BY eventDate DESC').all()
      .map((e) => ({ ...e, roomConfirmed: !!e.roomConfirmed, promotionDone: !!e.promotionDone,
                     logisticsSent: !!e.logisticsSent, tpusaNotified: !!e.tpusaNotified })));

  tool('create_speaker_event',
    'Create a speaker event (status starts at "Planning" with an empty checklist).',
    {
      title: z.string().min(1).max(200),
      speakerName: z.string().max(200).optional(),
      speakerOrg: z.string().max(200).optional(),
      topic: z.string().max(500).optional(),
      eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
      location: z.string().max(200).optional(),
      expectedAttendance: z.number().int().min(0).optional(),
      budgetEstimate: z.number().min(0).optional().describe('Dollars'),
    },
    (a) => {
      const actor = resolveActor();
      const info = db.prepare(`INSERT INTO speaker_events (title, speakerName, speakerOrg, topic, eventDate, location, expectedAttendance, budgetEstimate, createdById)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(a.title.trim(), a.speakerName || '', a.speakerOrg || '', a.topic || '', a.eventDate || null,
             a.location || '', a.expectedAttendance || 0, a.budgetEstimate || 0, actor ? actor.id : null);
      return { created: db.prepare('SELECT * FROM speaker_events WHERE id = ?').get(info.lastInsertRowid) };
    });

  tool('update_speaker_event',
    'Update a speaker event: details, checklist flags, status, or post-event wrap-up.',
    {
      eventId: id('speaker_events.id'),
      title: z.string().min(1).max(200).optional(),
      speakerName: z.string().max(200).optional(),
      speakerOrg: z.string().max(200).optional(),
      topic: z.string().max(500).optional(),
      eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
      location: z.string().max(200).optional(),
      expectedAttendance: z.number().int().min(0).optional(),
      budgetEstimate: z.number().min(0).optional(),
      roomConfirmed: z.boolean().optional(),
      promotionDone: z.boolean().optional(),
      logisticsSent: z.boolean().optional(),
      tpusaNotified: z.boolean().optional(),
      status: z.enum(['Planning', 'Confirmed', 'Completed', 'Cancelled']).optional(),
      actualAttendance: z.number().int().min(0).optional(),
      postEventNotes: z.string().max(5000).optional(),
    },
    (a) => {
      const ev = db.prepare('SELECT * FROM speaker_events WHERE id = ?').get(a.eventId);
      if (!ev) reject(`Speaker event ${a.eventId} not found`);
      const flag = (v) => (v !== undefined ? (v ? 1 : 0) : null);
      db.prepare(`UPDATE speaker_events SET
        title = COALESCE(?, title), speakerName = COALESCE(?, speakerName), speakerOrg = COALESCE(?, speakerOrg),
        topic = COALESCE(?, topic), eventDate = COALESCE(?, eventDate), location = COALESCE(?, location),
        expectedAttendance = COALESCE(?, expectedAttendance), budgetEstimate = COALESCE(?, budgetEstimate),
        roomConfirmed = COALESCE(?, roomConfirmed), promotionDone = COALESCE(?, promotionDone),
        logisticsSent = COALESCE(?, logisticsSent), tpusaNotified = COALESCE(?, tpusaNotified),
        status = COALESCE(?, status), actualAttendance = COALESCE(?, actualAttendance),
        postEventNotes = COALESCE(?, postEventNotes)
        WHERE id = ?`)
        .run(a.title ?? null, a.speakerName ?? null, a.speakerOrg ?? null, a.topic ?? null, a.eventDate ?? null,
             a.location ?? null, a.expectedAttendance ?? null, a.budgetEstimate ?? null,
             flag(a.roomConfirmed), flag(a.promotionDone), flag(a.logisticsSent), flag(a.tpusaNotified),
             a.status ?? null, a.actualAttendance ?? null, a.postEventNotes ?? null, a.eventId);
      return { updated: db.prepare('SELECT * FROM speaker_events WHERE id = ?').get(a.eventId) };
    });

  tool('delete_speaker_event',
    'Delete a speaker event.',
    { eventId: id('speaker_events.id') },
    ({ eventId }) => {
      const ev = db.prepare('SELECT id, title FROM speaker_events WHERE id = ?').get(eventId);
      if (!ev) reject(`Speaker event ${eventId} not found`);
      db.prepare('DELETE FROM speaker_events WHERE id = ?').run(eventId);
      return { deleted: ev };
    });

  // ---- Merch shop -----------------------------------------------------------

  tool('list_shop_items',
    'List all merch shop items (active and inactive) with prices in cents, inventory, and variants.',
    {},
    () => db.prepare('SELECT * FROM merch_items ORDER BY name').all().map((item) => ({
      id: item.id, name: item.name, description: item.description,
      priceCents: item.price, active: !!item.active, hasVariants: !!item.hasVariants,
      inventory: item.inventory,
      variants: db.prepare('SELECT id, label, inventory, priceOverride FROM merch_variants WHERE itemId = ? ORDER BY id').all(item.id),
    })));

  tool('create_shop_item',
    'Add a merch item to the shop. Price is in CENTS ($15 = 1500). Give either a flat inventory count, or variants (sizes/colors) each with their own inventory.',
    {
      name: z.string().min(1).max(120),
      priceCents: z.number().int().min(0).describe('Price in cents: $15.00 = 1500'),
      description: z.string().max(2000).optional(),
      inventory: z.number().int().min(0).optional().describe('Stock count (ignored when variants are given)'),
      variants: z.array(z.object({
        label: z.string().min(1).max(80).describe('e.g. "Small", "Large — Red"'),
        inventory: z.number().int().min(0),
        priceOverrideCents: z.number().int().min(0).optional(),
      })).optional(),
    },
    async ({ name, priceCents, description, inventory, variants }) => {
      const actor = resolveActor();
      const hasVariants = Array.isArray(variants) && variants.length > 0;
      const info = db.prepare(`INSERT INTO merch_items (name, description, price, hasVariants, inventory, createdById)
                               VALUES (?, ?, ?, ?, ?, ?)`)
        .run(name.trim(), (description || '').trim(), priceCents, hasVariants ? 1 : 0,
             hasVariants ? 0 : (inventory || 0), actor ? actor.id : null);
      const itemId = info.lastInsertRowid;
      for (const v of variants || []) {
        db.prepare('INSERT INTO merch_variants (itemId, label, inventory, priceOverride) VALUES (?, ?, ?, ?)')
          .run(itemId, v.label.trim(), v.inventory, v.priceOverrideCents ?? null);
      }
      // Best-effort Stripe product sync, same as the admin panel does.
      try { await ensureStripeProduct(db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId)); } catch {}
      return {
        created: db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId),
        note: 'No photo yet — add one from Admin Panel → Shop when convenient.',
      };
    });

  tool('update_shop_item',
    'Update a merch item: name, description, price (cents), flat inventory, or active (visible in shop).',
    {
      itemId: id('merch_items.id'),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      priceCents: z.number().int().min(0).optional(),
      inventory: z.number().int().min(0).optional(),
      active: z.boolean().optional(),
    },
    ({ itemId, name, description, priceCents, inventory, active }) => {
      const item = db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId);
      if (!item) reject(`Shop item ${itemId} not found`);
      db.prepare(`UPDATE merch_items SET name = COALESCE(?, name), description = COALESCE(?, description),
                  price = COALESCE(?, price), inventory = COALESCE(?, inventory), active = COALESCE(?, active) WHERE id = ?`)
        .run(name ?? null, description ?? null, priceCents ?? null, inventory ?? null,
             active !== undefined ? (active ? 1 : 0) : null, itemId);
      return { updated: db.prepare('SELECT * FROM merch_items WHERE id = ?').get(itemId) };
    });

  tool('update_shop_variant',
    'Update one variant\'s label, inventory, or price override (cents).',
    {
      variantId: id('merch_variants.id'),
      label: z.string().min(1).max(80).optional(),
      inventory: z.number().int().min(0).optional(),
      priceOverrideCents: z.number().int().min(0).nullable().optional().describe('null clears the override'),
    },
    ({ variantId, label, inventory, priceOverrideCents }) => {
      const v = db.prepare('SELECT * FROM merch_variants WHERE id = ?').get(variantId);
      if (!v) reject(`Variant ${variantId} not found`);
      db.prepare(`UPDATE merch_variants SET label = COALESCE(?, label), inventory = COALESCE(?, inventory),
                  priceOverride = CASE WHEN ? THEN ? ELSE priceOverride END WHERE id = ?`)
        .run(label ?? null, inventory ?? null,
             priceOverrideCents !== undefined ? 1 : 0, priceOverrideCents ?? null, variantId);
      return { updated: db.prepare('SELECT * FROM merch_variants WHERE id = ?').get(variantId) };
    });

  tool('list_shop_orders',
    'List shop orders, newest first. Amounts are in cents. fulfillmentStatus: pending | fulfilled | cancelled | needs_review.',
    {
      fulfillmentStatus: z.enum(['pending', 'fulfilled', 'cancelled', 'needs_review']).optional(),
      deliveryMethod: z.enum(['ship', 'pickup']).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    ({ fulfillmentStatus, deliveryMethod, limit }) => {
      let sql = 'SELECT * FROM merch_orders WHERE 1=1';
      const p = [];
      if (fulfillmentStatus) { sql += ' AND fulfillmentStatus = ?'; p.push(fulfillmentStatus); }
      if (deliveryMethod) { sql += ' AND deliveryMethod = ?'; p.push(deliveryMethod); }
      sql += ' ORDER BY createdAt DESC LIMIT ?'; p.push(limit || 100);
      return db.prepare(sql).all(...p).map((o) => {
        let shippingAddress = null;
        try { shippingAddress = o.shippingAddress ? JSON.parse(o.shippingAddress) : null; } catch {}
        return { ...o, shippingAddress };
      });
    });

  tool('update_shop_order',
    'Act on a shop order: mark-paid (cash/Venmo received), mark-fulfilled (handed over / shipped), cancel (restores inventory), or notes (replace the order notes).',
    {
      orderId: id('merch_orders.id'),
      action: z.enum(['mark-paid', 'mark-fulfilled', 'cancel', 'notes']),
      notes: z.string().max(2000).optional().describe('Required for the "notes" action'),
    },
    ({ orderId, action, notes }) => {
      const order = db.prepare('SELECT * FROM merch_orders WHERE id = ?').get(orderId);
      if (!order) reject(`Order ${orderId} not found`);
      if (action === 'mark-paid') {
        if (order.fulfillmentStatus === 'cancelled') reject('This order is cancelled');
        db.prepare("UPDATE merch_orders SET paymentStatus = 'paid' WHERE id = ?").run(orderId);
      } else if (action === 'mark-fulfilled') {
        if (order.fulfillmentStatus === 'cancelled') reject('This order is cancelled');
        db.prepare("UPDATE merch_orders SET fulfillmentStatus = 'fulfilled' WHERE id = ?").run(orderId);
      } else if (action === 'cancel') {
        if (order.fulfillmentStatus !== 'cancelled') {
          db.transaction(() => {
            // needs_review orders never decremented inventory, so don't restock them.
            if (order.fulfillmentStatus !== 'needs_review') {
              if (order.variantId) {
                db.prepare('UPDATE merch_variants SET inventory = inventory + ? WHERE id = ?').run(order.quantity, order.variantId);
              } else if (order.itemId) {
                db.prepare('UPDATE merch_items SET inventory = inventory + ? WHERE id = ?').run(order.quantity, order.itemId);
              }
            }
            db.prepare("UPDATE merch_orders SET fulfillmentStatus = 'cancelled' WHERE id = ?").run(orderId);
          })();
        }
      } else if (action === 'notes') {
        db.prepare('UPDATE merch_orders SET notes = ? WHERE id = ?').run(String(notes || '').trim().slice(0, 2000), orderId);
      }
      return { updated: db.prepare('SELECT * FROM merch_orders WHERE id = ?').get(orderId) };
    });

  // ---- Roster ---------------------------------------------------------------

  tool('list_roster',
    'List club roster members. status pipeline: Pending → Prospect → Contacted → Onboarded (or Declined / Inactive).',
    {
      status: z.enum(['Pending', 'Prospect', 'Contacted', 'Onboarded', 'Declined', 'Inactive']).optional(),
      grade: z.enum(GRADES).optional(),
      search: z.string().max(100).optional().describe('Match against first/last name or email'),
    },
    ({ status, grade, search }) => {
      let sql = `SELECT id, firstName, lastName, phone, email, grade, status, roleDescription, notes, createdAt
                 FROM roster_members WHERE 1=1`;
      const p = [];
      if (status) { sql += ' AND status = ?'; p.push(status); }
      if (grade) { sql += ' AND grade = ?'; p.push(Number(grade)); }
      if (search) { sql += " AND (firstName || ' ' || lastName LIKE ? OR email LIKE ?)"; p.push(`%${search}%`, `%${search}%`); }
      sql += ' ORDER BY lastName, firstName';
      return db.prepare(sql).all(...p);
    });

  tool('add_roster_member',
    'Add someone to the club roster (starts as a Prospect unless another status is given).',
    {
      firstName: z.string().min(1).max(100),
      lastName: z.string().max(100).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(200).optional(),
      grade: z.enum(GRADES).optional(),
      status: z.enum(['Prospect', 'Contacted', 'Onboarded']).optional(),
      notes: z.string().max(2000).optional(),
    },
    ({ firstName, lastName, phone, email, grade, status, notes }) => {
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) reject('Invalid email address');
      const info = db.prepare(`INSERT INTO roster_members (firstName, lastName, phone, email, grade, status, notes)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(firstName.trim(), (lastName || '').trim(), (phone || '').trim(), (email || '').trim(),
             grade ? Number(grade) : null, status || 'Prospect', (notes || '').trim());
      return { created: db.prepare('SELECT * FROM roster_members WHERE id = ?').get(info.lastInsertRowid) };
    });

  tool('update_roster_member',
    'Update a roster member\'s contact info, notes, or pipeline status. Status changes must follow the pipeline (e.g. Prospect → Contacted → Onboarded; no skipping Contacted).',
    {
      memberId: id('roster_members.id'),
      firstName: z.string().min(1).max(100).optional(),
      lastName: z.string().max(100).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(200).optional(),
      grade: z.enum(GRADES).optional(),
      status: z.enum(['Pending', 'Prospect', 'Contacted', 'Onboarded', 'Declined', 'Inactive']).optional(),
      notes: z.string().max(2000).optional(),
    },
    ({ memberId, firstName, lastName, phone, email, grade, status, notes }) => {
      const m = db.prepare('SELECT * FROM roster_members WHERE id = ?').get(memberId);
      if (!m) reject(`Roster member ${memberId} not found`);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) reject('Invalid email address');
      if (status && status !== m.status &&
          !(ROSTER_TRANSITIONS[m.status] && ROSTER_TRANSITIONS[m.status].includes(status))) {
        reject(`Cannot move a member from ${m.status} to ${status}`);
      }
      db.prepare(`UPDATE roster_members SET
        firstName = COALESCE(?, firstName), lastName = COALESCE(?, lastName), phone = COALESCE(?, phone),
        email = COALESCE(?, email), grade = COALESCE(?, grade), status = COALESCE(?, status),
        notes = COALESCE(?, notes), updatedAt = datetime('now') WHERE id = ?`)
        .run(firstName ?? null, lastName ?? null, phone ?? null, email ?? null,
             grade ? Number(grade) : null, status ?? null, notes ?? null, memberId);
      return { updated: db.prepare('SELECT * FROM roster_members WHERE id = ?').get(memberId) };
    });

  // ---- Funding, reimbursements, grants -------------------------------------

  tool('list_funding_requests',
    'List funding requests (status: pending | approved | denied | purchased).',
    { status: z.enum(['pending', 'approved', 'denied', 'purchased']).optional() },
    ({ status }) => {
      let sql = `SELECT fr.*, u.displayName AS submitterName FROM funding_requests fr
                 JOIN users u ON u.id = fr.submittedById`;
      const p = [];
      if (status) { sql += ' WHERE fr.status = ?'; p.push(status); }
      sql += ' ORDER BY fr.createdAt DESC';
      return db.prepare(sql).all(...p);
    });

  tool('review_funding_request',
    'Approve, deny, or mark-purchased a funding request (acts as admin; the submitter is notified and the action is audit-logged).',
    {
      requestId: id('funding_requests.id'),
      action: z.enum(['approve', 'deny', 'purchased']),
      reviewNotes: z.string().max(2000).optional(),
    },
    ({ requestId, action, reviewNotes }) => {
      const actor = resolveActor();
      const fr = db.prepare('SELECT * FROM funding_requests WHERE id = ?').get(requestId);
      if (!fr) reject(`Funding request ${requestId} not found`);
      if (actor && (action === 'approve' || action === 'deny') && fr.submittedById === actor.id) {
        reject('The acting admin cannot review their own funding request — have another manager do it in the app');
      }
      if ((action === 'approve' || action === 'deny') && fr.status !== 'pending') reject('This request has already been reviewed');
      if (action === 'purchased' && fr.status !== 'approved') reject('Only approved requests can be marked as purchased');
      const actorName = actor ? actor.displayName : 'Claude Assistant';
      if (action === 'approve') {
        db.transaction(() => {
          db.prepare(`UPDATE funding_requests SET status='approved', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?, reviewNotes) WHERE id=?`)
            .run(actor ? actor.id : null, reviewNotes ?? null, fr.id);
          logApproval('funding', fr.id, 'approved', actor, reviewNotes || fr.title);
        })();
        pushNotification(fr.submittedById, `Your funding request "${fr.title}" was approved by ${actorName}`, 'funding', 'funding');
      } else if (action === 'deny') {
        db.transaction(() => {
          db.prepare(`UPDATE funding_requests SET status='denied', reviewedById=?, reviewedAt=datetime('now'), reviewNotes=COALESCE(?, reviewNotes) WHERE id=?`)
            .run(actor ? actor.id : null, reviewNotes ?? null, fr.id);
          logApproval('funding', fr.id, 'denied', actor, reviewNotes || fr.title);
        })();
        pushNotification(fr.submittedById, `Your funding request "${fr.title}" was denied by ${actorName}`, 'funding', 'funding');
      } else {
        db.transaction(() => {
          db.prepare(`UPDATE funding_requests SET status='purchased', purchasedById=?, purchasedAt=datetime('now') WHERE id=?`)
            .run(actor ? actor.id : null, fr.id);
          logApproval('funding', fr.id, 'purchased', actor, fr.title);
        })();
        pushNotification(fr.submittedById, `Your funding request "${fr.title}" was marked purchased by ${actorName}`, 'funding', 'funding');
      }
      return { updated: db.prepare('SELECT * FROM funding_requests WHERE id = ?').get(fr.id) };
    });

  tool('list_reimbursements',
    'List expense reimbursement requests (status: pending | approved | denied).',
    { status: z.enum(['pending', 'approved', 'denied']).optional() },
    ({ status }) => {
      let sql = `SELECT r.*, u.displayName AS submitterName FROM reimbursements r
                 JOIN users u ON u.id = r.submittedById`;
      const p = [];
      if (status) { sql += ' WHERE r.status = ?'; p.push(status); }
      sql += ' ORDER BY r.createdAt DESC';
      return db.prepare(sql).all(...p);
    });

  tool('review_reimbursement',
    'Approve or deny a reimbursement request (acts as admin; the submitter is notified).',
    {
      reimbursementId: id('reimbursements.id'),
      action: z.enum(['approve', 'deny']),
      reviewNotes: z.string().max(2000).optional(),
    },
    ({ reimbursementId, action, reviewNotes }) => {
      const actor = resolveActor();
      const r = db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(reimbursementId);
      if (!r) reject(`Reimbursement ${reimbursementId} not found`);
      if (actor && r.submittedById === actor.id) {
        reject('The acting admin cannot review their own reimbursement — have another manager do it in the app');
      }
      const status = action === 'approve' ? 'approved' : 'denied';
      db.prepare(`UPDATE reimbursements SET status=?, reviewedById=?, reviewedAt=datetime('now'), reviewNotes=? WHERE id=?`)
        .run(status, actor ? actor.id : null, String(reviewNotes || '').trim(), r.id);
      pushNotification(r.submittedById, `Your reimbursement request ($${Number(r.amount).toFixed(2)} · ${r.category}) was ${status}.`, 'reimbursements', 'info');
      return { updated: db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(r.id) };
    });

  tool('list_grants',
    'List grant applications the club is tracking.',
    {},
    () => db.prepare('SELECT * FROM grant_applications ORDER BY createdAt DESC').all());

  tool('create_grant',
    'Track a new grant application (status starts at Draft).',
    {
      title: z.string().min(1).max(200),
      purpose: z.string().max(2000).optional(),
      amountRequested: z.number().min(0).optional().describe('Dollars'),
      submissionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes: z.string().max(5000).optional(),
    },
    ({ title, purpose, amountRequested, submissionDate, notes }) => {
      const actor = resolveActor();
      const info = db.prepare(`INSERT INTO grant_applications (title, purpose, amountRequested, submissionDate, notes, createdById)
                               VALUES (?, ?, ?, ?, ?, ?)`)
        .run(title.trim(), purpose || '', amountRequested || 0, submissionDate || null, notes || '', actor ? actor.id : null);
      return { created: db.prepare('SELECT * FROM grant_applications WHERE id = ?').get(info.lastInsertRowid) };
    });

  tool('update_grant',
    'Update a grant application: status (Draft/Submitted/Awarded/Rejected), amounts, notes.',
    {
      grantId: id('grant_applications.id'),
      title: z.string().min(1).max(200).optional(),
      purpose: z.string().max(2000).optional(),
      amountRequested: z.number().min(0).optional(),
      submissionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(['Draft', 'Submitted', 'Awarded', 'Rejected']).optional(),
      amountAwarded: z.number().min(0).optional(),
      notes: z.string().max(5000).optional(),
    },
    (a) => {
      const g = db.prepare('SELECT * FROM grant_applications WHERE id = ?').get(a.grantId);
      if (!g) reject(`Grant ${a.grantId} not found`);
      db.prepare(`UPDATE grant_applications SET title = COALESCE(?, title), purpose = COALESCE(?, purpose),
                  amountRequested = COALESCE(?, amountRequested), submissionDate = COALESCE(?, submissionDate),
                  status = COALESCE(?, status), amountAwarded = COALESCE(?, amountAwarded),
                  notes = COALESCE(?, notes), updatedAt = datetime('now') WHERE id = ?`)
        .run(a.title ?? null, a.purpose ?? null, a.amountRequested ?? null, a.submissionDate ?? null,
             a.status ?? null, a.amountAwarded ?? null, a.notes ?? null, a.grantId);
      return { updated: db.prepare('SELECT * FROM grant_applications WHERE id = ?').get(a.grantId) };
    });

  // ---- Social posts ---------------------------------------------------------

  tool('list_social_posts',
    'List the social media post tracker (status: Planned | Drafted | Posted).',
    {},
    () => db.prepare(`SELECT sp.*, u.displayName AS assignedTo FROM social_posts sp
                      LEFT JOIN users u ON u.id = sp.assignedToId ORDER BY sp.createdAt DESC`).all());

  tool('create_social_post',
    'Plan a social media post, optionally assigning it to a board member.',
    {
      platform: z.string().min(1).max(50).describe('e.g. Instagram, TikTok'),
      captionDraft: z.string().max(3000).optional(),
      imageDescription: z.string().max(1000).optional(),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      assignedToUserId: id('users.id to assign this post to').optional(),
    },
    ({ platform, captionDraft, imageDescription, scheduledDate, assignedToUserId }) => {
      const actor = resolveActor();
      if (assignedToUserId && !getUser(assignedToUserId)) reject(`No user with id ${assignedToUserId}`);
      const info = db.prepare(`INSERT INTO social_posts (platform, captionDraft, imageDescription, scheduledDate, assignedToId, createdById)
                               VALUES (?, ?, ?, ?, ?, ?)`)
        .run(platform.trim(), captionDraft || '', imageDescription || '', scheduledDate || null,
             assignedToUserId || null, actor ? actor.id : null);
      if (assignedToUserId) {
        pushNotification(assignedToUserId, `${actor ? actor.displayName : 'Claude Assistant'} assigned you a ${platform.trim()} post to create`, 'social', 'info');
      }
      return { created: db.prepare('SELECT * FROM social_posts WHERE id = ?').get(info.lastInsertRowid) };
    });

  tool('update_social_post',
    'Update a planned social post: caption, schedule, status (Planned/Drafted/Posted), posted date, or assignee.',
    {
      postId: id('social_posts.id'),
      captionDraft: z.string().max(3000).optional(),
      imageDescription: z.string().max(1000).optional(),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      postedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(['Planned', 'Drafted', 'Posted']).optional(),
      assignedToUserId: id('users.id').optional(),
    },
    (a) => {
      const sp = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(a.postId);
      if (!sp) reject(`Social post ${a.postId} not found`);
      if (a.assignedToUserId && !getUser(a.assignedToUserId)) reject(`No user with id ${a.assignedToUserId}`);
      db.prepare(`UPDATE social_posts SET captionDraft = COALESCE(?, captionDraft),
                  imageDescription = COALESCE(?, imageDescription), scheduledDate = COALESCE(?, scheduledDate),
                  postedDate = COALESCE(?, postedDate), status = COALESCE(?, status),
                  assignedToId = COALESCE(?, assignedToId) WHERE id = ?`)
        .run(a.captionDraft ?? null, a.imageDescription ?? null, a.scheduledDate ?? null,
             a.postedDate ?? null, a.status ?? null, a.assignedToUserId ?? null, a.postId);
      return { updated: db.prepare('SELECT * FROM social_posts WHERE id = ?').get(a.postId) };
    });

  // ---- Homepage, announcements, comms --------------------------------------

  tool('set_home_announcement',
    'Set (or clear) the announcement banner on the public homepage.',
    {
      text: z.string().max(1000).describe('Announcement text; empty string clears it'),
      enabled: z.boolean().describe('Whether the banner is shown'),
    },
    ({ text, enabled }) => {
      db.prepare(`UPDATE site_settings SET homeAnnouncement = ?, homeAnnouncementEnabled = ?, updatedAt = datetime('now') WHERE id = 1`)
        .run(text.trim().slice(0, 1000), enabled ? 1 : 0);
      return { updated: db.prepare('SELECT homeAnnouncement, homeAnnouncementEnabled FROM site_settings WHERE id = 1').get() };
    });

  tool('update_homepage',
    'Update the public homepage basics: weekly meeting date/time/location and the about text.',
    {
      meetingDate: z.string().max(100).optional().describe('e.g. "Every Tuesday"'),
      meetingTime: z.string().max(100).optional(),
      meetingLocation: z.string().max(200).optional(),
      aboutText: z.string().max(5000).optional(),
    },
    ({ meetingDate, meetingTime, meetingLocation, aboutText }) => {
      db.prepare(`UPDATE site_settings SET meetingDate = COALESCE(?, meetingDate), meetingTime = COALESCE(?, meetingTime),
                  meetingLocation = COALESCE(?, meetingLocation), aboutText = COALESCE(?, aboutText),
                  updatedAt = datetime('now') WHERE id = 1`)
        .run(meetingDate ?? null, meetingTime ?? null, meetingLocation ?? null, aboutText ?? null);
      return { updated: db.prepare('SELECT meetingDate, meetingTime, meetingLocation, aboutText FROM site_settings WHERE id = 1').get() };
    });

  tool('send_notification',
    'Send an in-app notification (bell menu, mirrored to Telegram if linked) to one board member. Use for reminders and heads-ups.',
    {
      userId: id('users.id of the recipient'),
      message: z.string().min(1).max(500),
    },
    ({ userId, message }) => {
      const u = getUser(userId);
      if (!u) reject(`No user with id ${userId}`);
      pushNotification(userId, message.trim(), '', 'info');
      return { sent: { to: u.displayName, message: message.trim() } };
    });

  tool('list_submissions',
    'List public "Get Involved" form submissions (people asking to join or apply).',
    { includeHandled: z.boolean().optional().describe('Also include already-handled submissions (default false)') },
    ({ includeHandled }) => db.prepare(
      includeHandled ? 'SELECT * FROM submissions ORDER BY createdAt DESC'
                     : 'SELECT * FROM submissions WHERE handled = 0 ORDER BY createdAt DESC').all());

  tool('mark_submission_handled',
    'Mark a public submission as handled.',
    { submissionId: id('submissions.id') },
    ({ submissionId }) => {
      const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
      if (!s) reject(`Submission ${submissionId} not found`);
      db.prepare('UPDATE submissions SET handled = 1 WHERE id = ?').run(submissionId);
      return { handled: { id: s.id, name: s.name, type: s.type } };
    });

  return server;
}

// Mounts the MCP endpoint on the Express app. helpers are the notification /
// audit-log / Stripe functions defined in index.js, so MCP actions flow
// through exactly the same plumbing as the web UI's own routes.
function registerMcpEndpoint(app, helpers) {
  if (!mcpEnabled) {
    if (MCP_SECRET) console.warn('[mcp] MCP_SECRET is set but shorter than 16 chars — MCP endpoint disabled. Use a long random string.');
    else console.log('[mcp] MCP_SECRET not set — remote MCP endpoint disabled.');
    return;
  }

  function checkSecret(req, res) {
    if (!timingSafeEqual(req.params.secret, MCP_SECRET)) {
      res.status(404).json({ error: 'Not found' });
      return false;
    }
    return true;
  }

  // JSON-RPC calls (initialize, tools/list, tools/call, ...) arrive as POST.
  // Stateless mode: a fresh server + transport per request. Claude reconnects
  // with full context each call, so no session state needs to live here.
  app.post('/mcp/:secret', async (req, res) => {
    if (!checkSecret(req, res)) return;
    const server = buildServer(helpers);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed:', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // GET/DELETE are part of the Streamable HTTP spec for stateful servers
  // (opening a standalone SSE stream / ending a session). This server is
  // stateless, so — per the SDK's own reference implementation — these must
  // return a clean 405 rather than being routed into transport.handleRequest,
  // which would otherwise demand an `Accept: text/event-stream` header and
  // return a confusing "Not Acceptable" error (this is also what you get if
  // you open the URL directly in a browser — that's expected, not a bug).
  const methodNotAllowed = (req, res) => {
    if (!checkSecret(req, res)) return;
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp/:secret', methodNotAllowed);
  app.delete('/mcp/:secret', methodNotAllowed);

  console.log('[mcp] Remote MCP endpoint enabled at /mcp/<secret> (' +
    'connect it as a claude.ai custom connector).');
}

module.exports = { registerMcpEndpoint, mcpEnabled };
