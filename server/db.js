const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'clubamerica.db')
    : path.join(__dirname, 'clubamerica.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT UNIQUE NOT NULL,
      firstName        TEXT NOT NULL,
      lastName         TEXT NOT NULL DEFAULT '',
      displayName      TEXT NOT NULL,
      passwordHash     TEXT NOT NULL,
      role             TEXT NOT NULL DEFAULT 'member',
      title            TEXT NOT NULL DEFAULT '',
      email            TEXT NOT NULL DEFAULT '',
      managerId        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      firstLogin       INTEGER NOT NULL DEFAULT 1,
      canEditHome      INTEGER NOT NULL DEFAULT 0,
      canAnnounce      INTEGER NOT NULL DEFAULT 0,
      canManageRoster  INTEGER NOT NULL DEFAULT 0,
      managedGrade     INTEGER,
      grade            TEXT NOT NULL DEFAULT '',
      photo            TEXT NOT NULL DEFAULT '',
      bio              TEXT NOT NULL DEFAULT '',
      profileComplete  INTEGER NOT NULL DEFAULT 0,
      createdAt        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      userId         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      dueDate        TEXT,
      status         TEXT NOT NULL DEFAULT 'Not Started',
      assignedById   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approvalStatus TEXT NOT NULL DEFAULT 'approved',
      approverId     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Single-row store for the public homepage content.
    CREATE TABLE IF NOT EXISTS site_settings (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      meetingDate             TEXT NOT NULL DEFAULT '',
      meetingTime             TEXT NOT NULL DEFAULT '',
      meetingLocation         TEXT NOT NULL DEFAULT '',
      podcastUrl              TEXT NOT NULL DEFAULT '',
      podcastEnabled          INTEGER NOT NULL DEFAULT 1,
      calendarUrl             TEXT NOT NULL DEFAULT '',
      instagramUrl            TEXT NOT NULL DEFAULT '',
      aboutText               TEXT NOT NULL DEFAULT '',
      homeAnnouncement        TEXT NOT NULL DEFAULT '',
      homeAnnouncementEnabled INTEGER NOT NULL DEFAULT 0,
      weeklyCheckinEnabled    INTEGER NOT NULL DEFAULT 0,
      updatedAt               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Public "Get Involved" submissions: club-join and board applications.
    CREATE TABLE IF NOT EXISTS submissions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL DEFAULT 'club',
      name      TEXT NOT NULL,
      email     TEXT NOT NULL,
      grade     TEXT NOT NULL DEFAULT '',
      message   TEXT NOT NULL DEFAULT '',
      handled   INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-user page feature flags configured by admins/managers.
    CREATE TABLE IF NOT EXISTS user_page_settings (
      userId              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bannerEnabled       INTEGER NOT NULL DEFAULT 0,
      bannerTitle         TEXT NOT NULL DEFAULT '',
      bannerUrl           TEXT NOT NULL DEFAULT '',
      calendarEnabled     INTEGER NOT NULL DEFAULT 0,
      calendarUrl         TEXT NOT NULL DEFAULT '',
      formEnabled         INTEGER NOT NULL DEFAULT 0,
      formTitle           TEXT NOT NULL DEFAULT '',
      formFields          TEXT NOT NULL DEFAULT '[]',
      announcementEnabled INTEGER NOT NULL DEFAULT 0,
      announcementText    TEXT NOT NULL DEFAULT '',
      bioEnabled          INTEGER NOT NULL DEFAULT 0,
      bioText             TEXT NOT NULL DEFAULT '',
      updatedAt           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One active broadcast announcement per manager/admin.
    CREATE TABLE IF NOT EXISTS team_announcements (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      authorId  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      text      TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Club roster: prospects through fully onboarded members.
    CREATE TABLE IF NOT EXISTS roster_members (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      firstName       TEXT NOT NULL,
      lastName        TEXT NOT NULL DEFAULT '',
      phone           TEXT NOT NULL DEFAULT '',
      email           TEXT NOT NULL DEFAULT '',
      grade           INTEGER,
      gender          TEXT NOT NULL DEFAULT '',
      roleDescription TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'Prospect',
      claimedByUserId INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes           TEXT NOT NULL DEFAULT '',
      convertedAt     TEXT,
      createdAt       TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Funding requests routed to CFO for review.
    CREATE TABLE IF NOT EXISTS funding_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      submittedById INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      amount        REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      reviewedById  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewedAt    TEXT,
      purchasedById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      purchasedAt   TEXT,
      reviewNotes   TEXT NOT NULL DEFAULT '',
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Weekly check-in submissions from board members.
    CREATE TABLE IF NOT EXISTS weekly_checkins (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      userId      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      weekOf      TEXT NOT NULL,
      submittedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Board / leadership position applications.
    CREATE TABLE IF NOT EXISTS board_applications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      userId        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      positionTitle TEXT NOT NULL,
      statement     TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending',
      reviewedById  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewedAt    TEXT,
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Public click / engagement tracking.
    CREATE TABLE IF NOT EXISTS page_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      event    TEXT NOT NULL,
      label    TEXT NOT NULL DEFAULT '',
      loggedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Login event log for productivity tracking (logistics view only).
    CREATE TABLE IF NOT EXISTS login_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username  TEXT NOT NULL,
      loginAt   TEXT NOT NULL DEFAULT (datetime('now')),
      ipAddress TEXT NOT NULL DEFAULT ''
    );

    -- AI-generated private notes for individual board members.
    CREATE TABLE IF NOT EXISTS ai_notes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content   TEXT NOT NULL,
      isRead    INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Chat history for AI conversations (admin only).
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      role      TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content   TEXT NOT NULL,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_session
      ON ai_chat_messages(userId, sessionId, createdAt);

    -- In-app notifications (delivered regardless of whether email is configured).
    CREATE TABLE IF NOT EXISTS notifications (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type      TEXT NOT NULL DEFAULT 'info',
      message   TEXT NOT NULL,
      link      TEXT NOT NULL DEFAULT '',
      isRead    INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(userId, isRead, createdAt);

    -- Audit trail for approvals / rejections / status changes on reviewable items.
    CREATE TABLE IF NOT EXISTS approval_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entityType TEXT NOT NULL,
      entityId   INTEGER NOT NULL,
      action     TEXT NOT NULL,
      actorId    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actorName  TEXT NOT NULL DEFAULT '',
      detail     TEXT NOT NULL DEFAULT '',
      createdAt  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_approval_log_entity
      ON approval_log(entityType, entityId);

    CREATE INDEX IF NOT EXISTS idx_roster_status_grade
      ON roster_members(status, grade);
    CREATE INDEX IF NOT EXISTS idx_roster_claimed
      ON roster_members(claimedByUserId);
    CREATE INDEX IF NOT EXISTS idx_funding_submitter
      ON funding_requests(submittedById, status);
    CREATE INDEX IF NOT EXISTS idx_board_apps_user
      ON board_applications(userId, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_user
      ON tasks(userId, approvalStatus);
    CREATE INDEX IF NOT EXISTS idx_login_logs_user
      ON login_logs(userId);
    CREATE INDEX IF NOT EXISTS idx_checkins_week
      ON weekly_checkins(weekOf);
    CREATE INDEX IF NOT EXISTS idx_page_events_loggedat
      ON page_events(loggedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_page_events_event
      ON page_events(event, label);

    -- Per-task comment threads.
    CREATE TABLE IF NOT EXISTS task_comments (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content   TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments ON task_comments(taskId, createdAt);

    -- Attendance: events (meetings, club nights, etc.). Events may be created
    -- manually or auto-imported: 'board' meetings come from the meetings table,
    -- 'club' meetings come from the linked Google Calendar feed. eventType drives
    -- which roster is shown; (sourceType, sourceId) dedupes auto-imported events.
    CREATE TABLE IF NOT EXISTS attendance_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      eventDate   TEXT NOT NULL,
      location    TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT '',
      eventType   TEXT NOT NULL DEFAULT 'club',
      sourceType  TEXT NOT NULL DEFAULT 'manual',
      sourceId    TEXT NOT NULL DEFAULT '',
      createdById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Attendance: who attended each event. An attendee is either a portal user
    -- (userId) or an onboarded roster contact (rosterId) — exactly one is set.
    CREATE TABLE IF NOT EXISTS attendance_records (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId    INTEGER NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
      userId     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      rosterId   INTEGER REFERENCES roster_members(id) ON DELETE CASCADE,
      status     TEXT NOT NULL DEFAULT 'present',
      markedById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_records ON attendance_records(eventId);

    -- Polls created by the President for all board members.
    CREATE TABLE IF NOT EXISTS polls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      question    TEXT NOT NULL,
      options     TEXT NOT NULL DEFAULT '[]',
      createdById INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status      TEXT NOT NULL DEFAULT 'open',
      createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
      closedAt    TEXT
    );

    -- One vote per member per poll.
    CREATE TABLE IF NOT EXISTS poll_votes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pollId      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      userId      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      optionIndex INTEGER NOT NULL,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pollId, userId)
    );
    CREATE INDEX IF NOT EXISTS idx_poll_votes ON poll_votes(pollId);

    -- Role / position descriptions editable by admins.
    CREATE TABLE IF NOT EXISTS role_descriptions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      positionTitle TEXT NOT NULL UNIQUE,
      description   TEXT NOT NULL DEFAULT '',
      updatedAt     TEXT NOT NULL DEFAULT (datetime('now')),
      updatedById   INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    -- Meeting records with links to Google Docs for agenda/minutes.
    CREATE TABLE IF NOT EXISTS meetings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      meetingDate TEXT NOT NULL,
      agendaUrl   TEXT NOT NULL DEFAULT '',
      minutesUrl  TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT '',
      createdById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Grant applications tracked by the treasurer/admin.
    CREATE TABLE IF NOT EXISTS grant_applications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      purpose         TEXT NOT NULL DEFAULT '',
      amountRequested REAL NOT NULL DEFAULT 0,
      submissionDate  TEXT,
      status          TEXT NOT NULL DEFAULT 'Draft',
      amountAwarded   REAL,
      notes           TEXT NOT NULL DEFAULT '',
      createdById     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt       TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Speaker events with pre-event checklist.
    CREATE TABLE IF NOT EXISTS speaker_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      speakerName        TEXT NOT NULL DEFAULT '',
      speakerOrg         TEXT NOT NULL DEFAULT '',
      topic              TEXT NOT NULL DEFAULT '',
      eventDate          TEXT,
      location           TEXT NOT NULL DEFAULT '',
      expectedAttendance INTEGER NOT NULL DEFAULT 0,
      avNeeds            TEXT NOT NULL DEFAULT '',
      materialsRequested TEXT NOT NULL DEFAULT '',
      budgetEstimate     REAL NOT NULL DEFAULT 0,
      roomConfirmed      INTEGER NOT NULL DEFAULT 0,
      promotionDone      INTEGER NOT NULL DEFAULT 0,
      logisticsSent      INTEGER NOT NULL DEFAULT 0,
      tpusaNotified      INTEGER NOT NULL DEFAULT 0,
      actualAttendance   INTEGER,
      postEventNotes     TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'Planning',
      createdById        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Social media posts tracker.
    CREATE TABLE IF NOT EXISTS social_posts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      platform         TEXT NOT NULL,
      captionDraft     TEXT NOT NULL DEFAULT '',
      imageDescription TEXT NOT NULL DEFAULT '',
      scheduledDate    TEXT,
      postedDate       TEXT,
      status           TEXT NOT NULL DEFAULT 'Planned',
      assignedToId     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdById      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-grade recruitment goals set by admins.
    CREATE TABLE IF NOT EXISTS grade_goals (
      grade INTEGER PRIMARY KEY,
      goal  INTEGER NOT NULL DEFAULT 0
    );

    -- Expense reimbursement requests submitted by any member.
    CREATE TABLE IF NOT EXISTS reimbursements (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      submittedById INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount        REAL NOT NULL DEFAULT 0,
      category      TEXT NOT NULL DEFAULT 'Other',
      description   TEXT NOT NULL DEFAULT '',
      purchaseDate  TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending',
      reviewedById  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewedAt    TEXT,
      reviewNotes   TEXT NOT NULL DEFAULT '',
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reimbursements_submitter
      ON reimbursements(submittedById, status);

    -- Shared resource library (links, templates, policies, etc.)
    CREATE TABLE IF NOT EXISTS resources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL DEFAULT '',
      url         TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT 'Other',
      description TEXT NOT NULL DEFAULT '',
      createdById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category, title);

    -- Action items captured during meetings.
    CREATE TABLE IF NOT EXISTS meeting_action_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meetingId   INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      text        TEXT NOT NULL DEFAULT '',
      assigneeId  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      dueDate     TEXT NOT NULL DEFAULT '',
      done        INTEGER NOT NULL DEFAULT 0,
      taskId      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      createdById INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_action_items ON meeting_action_items(meetingId);
    CREATE INDEX IF NOT EXISTS idx_action_items_assignee ON meeting_action_items(assigneeId, done);

    -- Volunteer-enabled iCal events (snapshotted when admin enables volunteers).
    CREATE TABLE IF NOT EXISTS volunteer_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      icalUid          TEXT UNIQUE NOT NULL,
      title            TEXT NOT NULL,
      location         TEXT NOT NULL DEFAULT '',
      startDate        TEXT NOT NULL,
      volunteersEnabled INTEGER NOT NULL DEFAULT 1,
      createdById      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Roles/slots for each volunteer event.
    CREATE TABLE IF NOT EXISTS volunteer_roles (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId   INTEGER NOT NULL REFERENCES volunteer_events(id) ON DELETE CASCADE,
      roleName  TEXT NOT NULL,
      cap       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_volunteer_roles ON volunteer_roles(eventId);

    -- Public sign-ups for volunteer roles.
    CREATE TABLE IF NOT EXISTS volunteer_signups (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId          INTEGER NOT NULL REFERENCES volunteer_events(id) ON DELETE CASCADE,
      roleId           INTEGER REFERENCES volunteer_roles(id) ON DELETE SET NULL,
      name             TEXT NOT NULL,
      phone            TEXT NOT NULL DEFAULT '',
      email            TEXT NOT NULL DEFAULT '',
      grade            TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'confirmed',
      matchedRosterId  INTEGER REFERENCES roster_members(id) ON DELETE SET NULL,
      createdAt        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_volunteer_signups_event ON volunteer_signups(eventId, status);
    CREATE INDEX IF NOT EXISTS idx_volunteer_signups_roster ON volunteer_signups(matchedRosterId);

    -- Photos submitted by anyone from the public homepage ("event photos").
    -- Held as 'pending' until a board member approves, so nothing unvetted ever
    -- appears on the public page.
    CREATE TABLE IF NOT EXISTS event_photos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      photo         TEXT NOT NULL,
      caption       TEXT NOT NULL DEFAULT '',
      submitterName TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending',
      approvedById  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approvedAt    TEXT,
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_photos_status ON event_photos(status, createdAt DESC);

    -- Board-curated "From Our Instagram" slideshow. Because Instagram blocks
    -- embeds for logged-out visitors, the board uploads the image itself and
    -- links it to the post — so it always renders and taps through to Instagram.
    CREATE TABLE IF NOT EXISTS instagram_highlights (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      image       TEXT NOT NULL,
      link        TEXT NOT NULL DEFAULT '',
      caption     TEXT NOT NULL DEFAULT '',
      sortOrder   INTEGER NOT NULL DEFAULT 0,
      createdById INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_instagram_highlights ON instagram_highlights(sortOrder, createdAt DESC);

    -- Member testimonials: submitted via private link or created directly by admins.
    -- Held as 'pending' until admin approves; only 'approved' ones appear publicly.
    CREATE TABLE IF NOT EXISTS testimonials (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL DEFAULT '',
      role                TEXT NOT NULL DEFAULT '',
      photo               TEXT NOT NULL DEFAULT '',
      text                TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'pending',
      submitToken         TEXT UNIQUE,
      submittedByMemberId INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sortOrder           INTEGER NOT NULL DEFAULT 0,
      createdAt           TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_testimonials_status ON testimonials(status, sortOrder, createdAt DESC);

    -- Newsletter subscriber list. Members are auto-enrolled; public visitors can sign up.
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'signup',
      active       INTEGER NOT NULL DEFAULT 1,
      subscribedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_email ON newsletter_subscribers(lower(email));

    -- Merch shop: items the secretary/admins stock and sell publicly.
    CREATE TABLE IF NOT EXISTS merch_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      price         INTEGER NOT NULL DEFAULT 0,
      photo         TEXT NOT NULL DEFAULT '',
      hasVariants   INTEGER NOT NULL DEFAULT 0,
      inventory     INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      createdById   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_merch_items_active ON merch_items(active, name);

    -- Size/color variants for an item, each with its own inventory count.
    CREATE TABLE IF NOT EXISTS merch_variants (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      itemId         INTEGER NOT NULL REFERENCES merch_items(id) ON DELETE CASCADE,
      label          TEXT NOT NULL,
      inventory      INTEGER NOT NULL DEFAULT 0,
      priceOverride  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_merch_variants_item ON merch_variants(itemId);

    -- Promo codes: free items or discounts, optionally student-only + capped usage.
    CREATE TABLE IF NOT EXISTS merch_promo_codes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT NOT NULL UNIQUE,
      type          TEXT NOT NULL DEFAULT 'percent',
      value         INTEGER NOT NULL DEFAULT 0,
      itemId        INTEGER REFERENCES merch_items(id) ON DELETE CASCADE,
      studentOnly   INTEGER NOT NULL DEFAULT 0,
      usageLimit    INTEGER,
      usedCount     INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      createdById   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Orders placed from the public shop.
    CREATE TABLE IF NOT EXISTS merch_orders (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      itemId                INTEGER REFERENCES merch_items(id) ON DELETE SET NULL,
      variantId             INTEGER REFERENCES merch_variants(id) ON DELETE SET NULL,
      itemName              TEXT NOT NULL DEFAULT '',
      variantLabel          TEXT NOT NULL DEFAULT '',
      quantity              INTEGER NOT NULL DEFAULT 1,
      buyerName             TEXT NOT NULL DEFAULT '',
      buyerEmail            TEXT NOT NULL DEFAULT '',
      buyerPhone            TEXT NOT NULL DEFAULT '',
      deliveryMethod        TEXT NOT NULL DEFAULT 'ship',
      shippingAddress       TEXT NOT NULL DEFAULT '',
      studentEmail          TEXT NOT NULL DEFAULT '',
      promoCodeId           INTEGER REFERENCES merch_promo_codes(id) ON DELETE SET NULL,
      promoCode             TEXT NOT NULL DEFAULT '',
      discountAmount        INTEGER NOT NULL DEFAULT 0,
      subtotal              INTEGER NOT NULL DEFAULT 0,
      total                 INTEGER NOT NULL DEFAULT 0,
      paymentMethod         TEXT NOT NULL DEFAULT 'inperson',
      paymentStatus         TEXT NOT NULL DEFAULT 'pending',
      fulfillmentStatus     TEXT NOT NULL DEFAULT 'pending',
      stripePaymentIntentId TEXT NOT NULL DEFAULT '',
      notes                 TEXT NOT NULL DEFAULT '',
      createdAt             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_merch_orders_status ON merch_orders(fulfillmentStatus, createdAt DESC);
    -- One order per Stripe PaymentIntent: lets the /order route and the webhook
    -- both finalize the same payment without ever double-recording it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merch_orders_stripe
      ON merch_orders(stripePaymentIntentId) WHERE stripePaymentIntentId != '';
  `);

  // User column migrations.
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes('canEditHome'))     db.exec("ALTER TABLE users ADD COLUMN canEditHome INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('canAnnounce')) {
    db.exec("ALTER TABLE users ADD COLUMN canAnnounce INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE users SET canAnnounce = 1 WHERE username IN ('campbell', 'dhays')").run();
  }
  if (!cols.includes('canManageRoster')) {
    db.exec("ALTER TABLE users ADD COLUMN canManageRoster INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE users SET canManageRoster = 1 WHERE title IN ('Secretary', 'Grade Rep')").run();
  }
  if (!cols.includes('managedGrade'))    db.exec("ALTER TABLE users ADD COLUMN managedGrade INTEGER");
  if (!cols.includes('grade'))           db.exec("ALTER TABLE users ADD COLUMN grade TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('photo'))           db.exec("ALTER TABLE users ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('bio'))             db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('profileComplete')) db.exec("ALTER TABLE users ADD COLUMN profileComplete INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('email'))           db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('bigBoard')) {
    db.exec("ALTER TABLE users ADD COLUMN bigBoard INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE users SET bigBoard = 1 WHERE role = 'admin' OR role = 'manager' OR title = 'Secretary'").run();
  }
  if (!cols.includes('canViewLogistics')) db.exec("ALTER TABLE users ADD COLUMN canViewLogistics INTEGER NOT NULL DEFAULT 0");

  // Task column migrations.
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  if (!taskCols.includes('docUrl'))        db.exec("ALTER TABLE tasks ADD COLUMN docUrl TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes('isRecurring'))   db.exec("ALTER TABLE tasks ADD COLUMN isRecurring INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes('recurringDays')) db.exec("ALTER TABLE tasks ADD COLUMN recurringDays TEXT NOT NULL DEFAULT ''");
  // Links a delegated sub-task back to the parent task it was spun off from.
  if (!taskCols.includes('parentTaskId'))  db.exec("ALTER TABLE tasks ADD COLUMN parentTaskId INTEGER REFERENCES tasks(id) ON DELETE CASCADE");

  // roster_members column migrations.
  const rosterCols = db.prepare("PRAGMA table_info(roster_members)").all().map((c) => c.name);
  if (!rosterCols.includes('parentFormCollected')) db.exec("ALTER TABLE roster_members ADD COLUMN parentFormCollected INTEGER NOT NULL DEFAULT 0");
  if (!rosterCols.includes('linkedUserId')) {
    db.exec("ALTER TABLE roster_members ADD COLUMN linkedUserId INTEGER REFERENCES users(id) ON DELETE SET NULL");
    // Backfill: link existing roster members to users with matching emails.
    db.exec(`UPDATE roster_members SET linkedUserId = (
      SELECT u.id FROM users u WHERE u.email != '' AND lower(u.email) = lower(roster_members.email) LIMIT 1
    ) WHERE linkedUserId IS NULL AND email != ''`);
  }

  // volunteer_signups column migrations.
  const vsCols = db.prepare("PRAGMA table_info(volunteer_signups)").all().map((c) => c.name);
  if (!vsCols.includes('needsReview')) db.exec("ALTER TABLE volunteer_signups ADD COLUMN needsReview INTEGER NOT NULL DEFAULT 0");

  // attendance_events column migrations: type + auto-import source tracking.
  const aeCols = db.prepare("PRAGMA table_info(attendance_events)").all().map((c) => c.name);
  if (!aeCols.includes('eventType'))  db.exec("ALTER TABLE attendance_events ADD COLUMN eventType TEXT NOT NULL DEFAULT 'club'");
  if (!aeCols.includes('sourceType')) db.exec("ALTER TABLE attendance_events ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'manual'");
  if (!aeCols.includes('sourceId'))   db.exec("ALTER TABLE attendance_events ADD COLUMN sourceId TEXT NOT NULL DEFAULT ''");

  // attendance_records migration: add rosterId so onboarded (non-account) club
  // members can be marked. SQLite can't drop the old NOT NULL on userId in place,
  // so rebuild the table when rosterId is absent.
  const arCols = db.prepare("PRAGMA table_info(attendance_records)").all().map((c) => c.name);
  if (!arCols.includes('rosterId')) {
    db.exec(`
      CREATE TABLE attendance_records_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        eventId    INTEGER NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
        userId     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        rosterId   INTEGER REFERENCES roster_members(id) ON DELETE CASCADE,
        status     TEXT NOT NULL DEFAULT 'present',
        markedById INTEGER REFERENCES users(id) ON DELETE SET NULL,
        createdAt  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO attendance_records_new (id, eventId, userId, rosterId, status, markedById, createdAt)
        SELECT id, eventId, userId, NULL, status, markedById, COALESCE(createdAt, datetime('now')) FROM attendance_records;
      DROP TABLE attendance_records;
      ALTER TABLE attendance_records_new RENAME TO attendance_records;
      CREATE INDEX IF NOT EXISTS idx_attendance_records ON attendance_records(eventId);
    `);
  }
  // Partial unique indexes (created here, after the rebuild above guarantees the
  // rosterId column exists, so they're safe on both fresh and migrated databases).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_records_user
      ON attendance_records(eventId, userId) WHERE userId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_records_roster
      ON attendance_records(eventId, rosterId) WHERE rosterId IS NOT NULL;
  `);

  // Additional user column migrations.
  if (!cols.includes('canManageSocial')) db.exec("ALTER TABLE users ADD COLUMN canManageSocial INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('hiddenTabs')) db.exec("ALTER TABLE users ADD COLUMN hiddenTabs TEXT NOT NULL DEFAULT ''");

  // Auto-enroll existing users with email addresses into the newsletter list.
  try {
    db.exec(`INSERT OR IGNORE INTO newsletter_subscribers (email, name, source)
      SELECT lower(trim(email)), displayName, 'auto' FROM users
      WHERE trim(email) != '' AND email IS NOT NULL`);
  } catch (_) {}

  // Remove the old dedicated logistics observer account — the dashboard is now
  // accessible to admins directly and via the canViewLogistics permission.
  db.prepare("DELETE FROM users WHERE username = 'logistics'").run();

  // site_settings column migrations.
  const siteCols = db.prepare("PRAGMA table_info(site_settings)").all().map((c) => c.name);
  if (!siteCols.includes('podcastEnabled'))          db.exec("ALTER TABLE site_settings ADD COLUMN podcastEnabled INTEGER NOT NULL DEFAULT 1");
  if (!siteCols.includes('calendarUrl'))              db.exec("ALTER TABLE site_settings ADD COLUMN calendarUrl TEXT NOT NULL DEFAULT ''");
  if (!siteCols.includes('instagramUrl'))             db.exec("ALTER TABLE site_settings ADD COLUMN instagramUrl TEXT NOT NULL DEFAULT ''");
  if (!siteCols.includes('aboutText'))                db.exec("ALTER TABLE site_settings ADD COLUMN aboutText TEXT NOT NULL DEFAULT ''");
  if (!siteCols.includes('homeAnnouncement'))         db.exec("ALTER TABLE site_settings ADD COLUMN homeAnnouncement TEXT NOT NULL DEFAULT ''");
  if (!siteCols.includes('homeAnnouncementEnabled'))  db.exec("ALTER TABLE site_settings ADD COLUMN homeAnnouncementEnabled INTEGER NOT NULL DEFAULT 0");
  if (!siteCols.includes('weeklyCheckinEnabled'))     db.exec("ALTER TABLE site_settings ADD COLUMN weeklyCheckinEnabled INTEGER NOT NULL DEFAULT 0");
  if (!siteCols.includes('announcementPostedAt'))     db.exec("ALTER TABLE site_settings ADD COLUMN announcementPostedAt TEXT");
  if (!siteCols.includes('instagramPosts'))           db.exec("ALTER TABLE site_settings ADD COLUMN instagramPosts TEXT NOT NULL DEFAULT '[]'");

  // user_page_settings column migrations.
  const upsCols = db.prepare("PRAGMA table_info(user_page_settings)").all().map((c) => c.name);
  if (!upsCols.includes('bioEnabled'))  db.exec("ALTER TABLE user_page_settings ADD COLUMN bioEnabled INTEGER NOT NULL DEFAULT 0");
  if (!upsCols.includes('bioText'))     db.exec("ALTER TABLE user_page_settings ADD COLUMN bioText TEXT NOT NULL DEFAULT ''");

  // merch_orders: replace the earlier non-unique Stripe index with a partial
  // UNIQUE one so a PaymentIntent can be finalized exactly once. Safe to run
  // repeatedly; only drops/recreates when the current index isn't unique.
  const stripeIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_merch_orders_stripe'").get();
  if (stripeIdx && !/UNIQUE/i.test(stripeIdx.sql || '')) {
    db.exec("DROP INDEX idx_merch_orders_stripe");
    db.exec("CREATE UNIQUE INDEX idx_merch_orders_stripe ON merch_orders(stripePaymentIntentId) WHERE stripePaymentIntentId != ''");
  }

  // Ensure the homepage row exists.
  db.prepare(`INSERT OR IGNORE INTO site_settings (id, meetingDate, meetingTime, meetingLocation, podcastUrl)
              VALUES (1, 'To be announced', 'To be announced', 'To be announced', '')`).run();
}

// ---- Seed data ---------------------------------------------------------------
const SEED_USERS = [
  { username: 'fthomas',     firstName: 'Finley',   lastName: 'Thomas',     role: 'admin',   title: 'President',                manager: null },
  { username: 'deddy',       firstName: 'Derek',    lastName: 'Eddy',       role: 'admin',   title: 'Vice President',           manager: 'fthomas' },

  { username: 'mflachsmann', firstName: 'Max',      lastName: 'Flachsmann', role: 'manager', title: 'Chair Public Engagement',  manager: 'deddy' },
  { username: 'hfossey',     firstName: 'Hudson',   lastName: 'Fossey',     role: 'manager', title: 'CFO',                      manager: 'deddy' },
  { username: 'dhays',       firstName: 'Dane',     lastName: 'Hays',       role: 'manager', title: 'Digital Presence Manager', manager: 'deddy' },

  { username: 'campbell',    firstName: 'Campbell', lastName: '',           role: 'member',  title: 'Secretary',                manager: 'deddy' },
  { username: 'aperillo',    firstName: 'Andrew',   lastName: 'Perillo',    role: 'member',  title: 'Hospitality',              manager: 'deddy' },
  { username: 'afox',        firstName: 'Audrey',   lastName: 'Fox',        role: 'member',  title: 'Swag Manager',             manager: 'deddy' },

  { username: 'lmoffat',     firstName: 'Ledger',   lastName: 'Moffat',     role: 'member',  title: 'Public Engagement',        manager: 'mflachsmann' },
  { username: 'whaladin',    firstName: 'Will',     lastName: 'Haladin',    role: 'member',  title: 'Fundraising & Volunteer',  manager: 'hfossey' },
  { username: 'jkindt',      firstName: 'Jacob',    lastName: 'Kindt',      role: 'member',  title: 'Content Editor',           manager: 'dhays' },
  { username: 'sgavin',      firstName: 'Sosie',    lastName: 'Gavin',      role: 'member',  title: 'Historian',                manager: 'dhays' },
  { username: 'ssosie',      firstName: 'Sosie',    lastName: '',           role: 'member',  title: 'Historian',                manager: 'dhays' },

  { username: 'dhuges',      firstName: 'Davis',    lastName: 'Hughes',     role: 'member',  title: 'Grade Rep',                manager: 'deddy' },
  { username: 'lmcnalley',   firstName: 'Liam',     lastName: 'McNalley',   role: 'member',  title: 'Grade Rep',                manager: 'deddy' },
  { username: 'tsummers',    firstName: 'Thomas',   lastName: 'Summers',    role: 'member',  title: 'Grade Rep',                manager: 'deddy' },
  { username: 'banderson',   firstName: 'Ben',      lastName: 'Anderson',   role: 'member',  title: 'Grade Rep',                manager: 'deddy' },
  { username: 'nneath',      firstName: 'Nola',     lastName: 'Neath',      role: 'member',  title: 'Grade Rep',                manager: 'deddy' },
  { username: 'bhastings',   firstName: 'Ben',      lastName: 'Hastings',   role: 'member',  title: 'Grade Rep',                manager: 'deddy' },
];

function displayNameFor(u) {
  return u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName;
}

function seed() {
  // The hidden 'logistics' observer is created in init() before seeding, so it
  // must be excluded here — otherwise a fresh database would look "non-empty"
  // and the board accounts would never be seeded.
  const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE username != 'logistics'").get().n;
  if (count > 0) return false;

  const insert = db.prepare(`
    INSERT INTO users (username, firstName, lastName, displayName, passwordHash, role, title, firstLogin)
    VALUES (@username, @firstName, @lastName, @displayName, @passwordHash, @role, @title, 1)
  `);

  const tx = db.transaction(() => {
    for (const u of SEED_USERS) {
      insert.run({
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        displayName: displayNameFor(u),
        passwordHash: bcrypt.hashSync(u.username, 10),
        role: u.role,
        title: u.title,
      });
    }
    const byUsername = {};
    for (const row of db.prepare('SELECT id, username FROM users').all()) {
      byUsername[row.username] = row.id;
    }
    const setManager = db.prepare('UPDATE users SET managerId = ? WHERE username = ?');
    for (const u of SEED_USERS) {
      if (u.manager) setManager.run(byUsername[u.manager], u.username);
    }
    db.prepare("UPDATE users SET canEditHome = 1 WHERE username IN ('fthomas', 'deddy', 'dhays')").run();
    db.prepare("UPDATE users SET canAnnounce = 1 WHERE username IN ('campbell', 'dhays')").run();
    db.prepare("UPDATE users SET canManageRoster = 1 WHERE title IN ('Secretary', 'Grade Rep')").run();
    db.prepare("UPDATE users SET bigBoard = 1 WHERE username IN ('fthomas','deddy','mflachsmann','hfossey','dhays','campbell')").run();

    // Grade reps: assign which grade they cover.
    const setGrade = db.prepare('UPDATE users SET grade = ? WHERE username = ?');
    setGrade.run('9',  'dhuges');
    setGrade.run('10', 'lmcnalley');
    setGrade.run('10', 'tsummers');
    setGrade.run('11', 'banderson');
    setGrade.run('11', 'nneath');
    setGrade.run('12', 'bhastings');
  });
  tx();
  return true;
}

module.exports = { db, init, seed, SEED_USERS, displayNameFor };
