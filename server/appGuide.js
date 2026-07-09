// Curated knowledge base for the in-app How-To / Q&A assistant.
//
// This is a hand-written guide to the whole app, derived from the actual
// features and permission rules in server/index.js and public/app.js. The
// How-To assistant (chatWithHowTo in ai.js) is grounded ONLY in this text, so
// keep it up to date when features or permissions change. It intentionally
// contains no private club data — only how to use the software and who can
// access what.

const APP_GUIDE = `# Club America Management — App Guide

This is the board-management web app for the Club America club at Park City High
School. Members log in to a private portal to manage tasks, meetings, attendance,
funding, recruiting, and the public website. This guide explains what every tab
does, how to perform common actions, and who is allowed to do what.

## Roles & permissions

There are three roles:
- **admin** — President & Vice President. Full access to everything.
- **manager** — Chairs / leadership (e.g. CFO, Chair of Public Engagement,
  Digital Presence Manager). Can manage their team and most leadership tools.
- **member** — Standard board members. See their own work and shared club tabs.

A user's role is partly automatic: anyone who has other users reporting to them
(is set as a manager of someone) is treated as at least a manager.

On top of roles there are permission flags an admin can grant to any user:
- **canEditHome** — may edit the public website ("Edit Website" tab).
- **canManageRoster** — may manage the recruiting roster (Secretary, Grade Reps).
- **canManageSocial** — may use the Social Media tools and Photo Approvals.
- **canManageNewsletter** — may manage the Newsletter (granted to the Secretary by default).
- **canViewLogistics** — may view the Login Activity dashboard.
- **managedGrade / grade** — Grade Reps; unlocks the Grade Pipeline and "Get
  Involved" for their grade.

If you can't see a tab, it's because your role/permissions don't include it, or an
admin hid it for your account in the Admin Panel.

## Navigating the app

After logging in you land on the **home grid** of tiles. Tap any tile to open that
tab. Use the **back arrow** in the header to return, the **search** icon to jump to
anything, and the **notification bell** for alerts. First-time login asks you to
change your password and complete your profile.

---

## Tabs everyone sees (My Club)

### My Page
Your personal task list. See tasks assigned to you, update each task's status
(Not Started → In Progress → Complete), open attached docs, and comment. When a
task needs approval, completing it sends it to your manager for review.

### Club Home
The club's internal home view: upcoming events, announcements, and the podcast/
links. Admins (or anyone with canEditHome) see an editable version via "Edit Website".

### Check-In
The weekly Friday check-in. When check-ins are enabled, fill in your short update
for the week. Leadership uses these to see who's engaged.

### Polls & Voting
Vote on polls the President posts. Open a poll, pick an option, and submit. Only
admins can create polls; everyone can vote.

### Meetings
The meetings hub. The **board meetings** list shows formal meeting records with
links to the agenda and minutes (Google Docs) and action items. The **calendar**
view shows upcoming club meetings/events pulled from the club's Google Calendar.
Managers/admins can add meeting records, attach agenda/minutes URLs, and create
action items (which can be promoted into tasks). Only admins can delete a meeting.

### Funding
Submit a funding request (title, amount, description). It routes to the CFO/admins
for review; you can track its status (pending → approved/denied → purchased).

### Apply
Apply for a board/leadership position. Submit an application that admins review and
approve or decline.

### Reimbursements
Request reimbursement for money you spent for the club, and track approval status.

### Resources
The resource hub — shared links, documents, and reference material for the board.

### Directory
The board directory: every member's name, title, and contact/profile info.

### Org Chart
A visual of the reporting hierarchy (who reports to whom).

### Agent Notes
Opens a panel of private AI-generated notes for you — gentle nudges (e.g. about
overdue tasks or missed check-ins). Mark a note as read when you've seen it.

---

## How do I take attendance? (Attendance tab — managers & admins)

Attendance lets leadership track who shows up to meetings and events.

- **Events auto-import.** Board meetings you add on the Meetings page appear here
  automatically as **Board** events, and upcoming items from the club's Google
  Calendar appear as **Club** events. You don't have to create these by hand.
- **The roster depends on the event type:**
  - **Board** events show the full board (all portal accounts).
  - **Club** events show the full club — all board accounts PLUS recruiting roster
    contacts marked "Onboarded" (these show a small "Club" tag).
- **To mark attendance:** select an event from the list, then tap Present / Absent /
  Excused next to each person. Changes save immediately.
- **Roll Call:** tap "Roll Call" on an event for a fast full-screen pass to mark
  everyone quickly, then Submit. It uses that event's specific roster and pre-fills
  anyone already marked.
- **Manual events:** admins can tap "+ New Event" to create a one-off event and
  choose whether it's a Club or Board event.
- **Deleting:** only admins can delete, and only manually-created events (auto-
  imported ones are managed by their source so they aren't deletable here).

---

## Leadership tabs (managers & admins)

### Announcement
Post a team announcement to the board.

### My Team
See your direct reports, their tasks and progress, and open any member's page.

### Approvals
Review tasks your reports marked complete; approve or send them back. This is also
where task approvals and the audit log live.

### Get Involved
The inbox of public submissions — students who filled out the join/interest form or
applied. Review and act on them. (Grade Reps see their grade's submissions.)
New submissions also land on the recipient's task page automatically: a club-join
request gives that grade's reps a "Reach out to new member ___" to-do, and a board
application gives the admins a "Review board application" to-do.

### Roster
The recruiting pipeline. Track prospective members through stages
(Prospect → Contacted → Onboarded), record contact info, and convert them. Requires
manager/admin or the canManageRoster permission.

### Dashboard
A leadership overview of club activity and health.

### Volunteers
Manage volunteer events and sign-ups: enable volunteers on a calendar event, define
roles/slots with caps, and review who signed up.

### Speaker Events
Plan speaker events with a logistics checklist (AV needs, room confirmation,
promotion, budget, attendance, post-event notes). Submitting a new speaker request
automatically adds a "Review speaker request" to-do to the Vice President's task page.
The Applications tab collects public speaker applications submitted at
/apply-to-speak (applicants who need AV or travel attach a signed logistics PDF you
can download). Admins can edit the public application's questions, order, and
wording on the Application Form tab — no code changes needed.

### Grant Tracker
Track grant applications (title, purpose, amount requested, submission date, status).

### Social Media
Plan and track social posts. Available to managers/admins or anyone with
canManageSocial. Photo Approvals (moderating photos submitted from the public site)
is also here for those users.

### Budget Overview
A financial summary across all funding requests — totals requested, approved/spent,
reimbursed, and pending.

### Grade Pipeline
Recruiting progress by grade with goals, for Grade Reps and leadership.

---

## How-To (this tab — managers & admins)
This AI assistant. Ask in plain language how to do anything in the app — for
example "How do I take attendance?", "How do I approve a funding request?", or
"Who can edit the website?" — and it answers from this guide. It does not access
private club data; for questions about specific people, tasks, or numbers, use the
**AI Assistant** tab (admins only).

---

## Site & Admin tabs (admins)

### Edit Website
Edit the public homepage: meeting details, announcement banner, podcast link,
calendar URL, about text, and more. Also available to users with canEditHome.

### Testimonials
Review and publish testimonials submitted by the public.

### Newsletter
Manage newsletter subscribers and send updates.

### Admin Panel
Manage user accounts: create users, set roles and titles, grant permission flags,
assign managers, and hide specific tabs per user.

### Login Activity
A dashboard of who has logged in and how recently. Admins, or users with
canViewLogistics, can view it.

### AI Assistant
An admin-only assistant that answers questions about the club's actual data — team
health, tasks, check-ins, funding, and login activity — and can run a team-health
analysis that writes private "Agent Notes" to members. (Different from this How-To
tab, which only explains how to use the app.)

---

## Common questions

- **Why can't I see a tab?** Your role/permissions don't include it, or an admin
  hid it for your account. Ask an admin to grant the role/permission in the Admin
  Panel.
- **Who approves my tasks/funding?** Your manager approves completed tasks;
  funding goes to the CFO/admins.
- **How do I change my password or profile?** Use the account/profile options from
  the header menu.
- **AI features say they're unavailable.** The server needs an ANTHROPIC_API_KEY
  configured by the administrator.
`;

module.exports = { APP_GUIDE };
