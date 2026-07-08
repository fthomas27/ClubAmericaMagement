// ---------------------------------------------------------------------------
// Speaker Application Form — question configuration.
//
// The form at /apply-to-speak is NOT hardcoded in the frontend. It renders
// whatever question list is stored in the speaker_form_config table, which
// the VP edits from Speaker Events → Application Form in the portal. This
// file only defines the DEFAULT config (seeded once into the database) and
// the sanitizers that keep VP edits and public submissions well-formed.
//
// Question shape:
//   {
//     id:                stable key, auto-slugged from the label if omitted
//     label:              the question text shown to the applicant
//     type:               'text' | 'email' | 'textarea' | 'select' | 'yesno'
//     required:           true/false
//     placeholder:        optional input hint (text/email/textarea)
//     helpText:           optional smaller line under the label
//     options:            array of choices (select only)
//     triggersUpload:     yesno only — answering "Yes" requires the applicant
//                         to download, complete, and re-upload a signed PDF
//                         before the application can be submitted. Any number
//                         of questions can set this, each with its own PDF
//                         template (stored in speaker_form_templates, managed
//                         from the editor) and its own heading/instructions.
//     uploadHeading:      yesno + triggersUpload only — heading shown above
//                         this question's upload section
//     uploadInstructions: yesno + triggersUpload only — instructions shown
//                         above the download/upload buttons
//   }
// ---------------------------------------------------------------------------

const QUESTION_TYPES = ['text', 'email', 'textarea', 'select', 'yesno'];

const DEFAULT_UPLOAD_HEADING = 'Signed Form Required';
const DEFAULT_UPLOAD_INSTRUCTIONS =
  'Please download the form below, fill it out, sign it, and upload the completed PDF. ' +
  'Your application cannot be submitted without it.';

const DEFAULT_SPEAKER_FORM = {
  title: 'Apply to Speak',
  intro:
    'Club America hosts speakers throughout the school year — activists, veterans, business leaders, and voices for faith and freedom. ' +
    'Tell us about yourself and your talk, and our Vice President will follow up.',
  questions: [
    { id: 'fullName',     label: 'Full Name',                          type: 'text',     required: true,  placeholder: 'Jane Doe' },
    { id: 'email',        label: 'Email Address',                      type: 'email',    required: true,  placeholder: 'you@example.com' },
    { id: 'phone',        label: 'Phone Number',                       type: 'text',     required: false, placeholder: '(555) 555-5555' },
    { id: 'organization', label: 'Organization / Affiliation',         type: 'text',     required: false, placeholder: 'e.g. TPUSA, local business, veteran' },
    { id: 'topic',        label: 'Proposed Topic or Title of Talk',    type: 'text',     required: true },
    { id: 'summary',      label: 'Brief Summary of Your Talk',         type: 'textarea', required: true,
      helpText: 'A few sentences on what you would cover and why it matters to high-school students.' },
    { id: 'format',       label: 'Preferred Format',                   type: 'select',   required: true,
      options: ['Lecture / presentation', 'Q&A / fireside chat', 'Panel discussion', 'Workshop', 'Flexible'] },
    { id: 'availability', label: 'General Availability',               type: 'text',     required: false,
      placeholder: 'e.g. Weekday afternoons, spring semester' },
    { id: 'needsLogistics',
      label: 'Do you require AV equipment or travel accommodations?',
      type: 'yesno', required: true, triggersUpload: true,
      helpText: 'If yes, we need our signed logistics request form before we can review your application.',
      uploadHeading: 'AV & Travel Logistics Form (required)',
      uploadInstructions:
        'Since you need AV equipment or travel accommodations, please download our logistics request form, ' +
        'fill it out, sign it, and upload the completed PDF below. Your application cannot be submitted without it.' },
  ],
};

function slugify(label, fallback) {
  const s = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || fallback;
}

// Normalize a VP-edited question list into something the renderer and the
// submission validator can both trust. Invalid entries are dropped rather than
// rejected wholesale, so one bad row can't lock the VP out of saving.
function sanitizeQuestions(input) {
  const arr = Array.isArray(input) ? input.slice(0, 30) : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const q = arr[i] || {};
    const label = String(q.label || '').trim().slice(0, 300);
    if (!label) continue;
    const type = QUESTION_TYPES.includes(q.type) ? q.type : 'text';
    let id = /^[a-zA-Z0-9_-]{1,40}$/.test(String(q.id || '')) ? String(q.id) : slugify(label, 'q' + (i + 1));
    while (seen.has(id)) id += '_' + (i + 1);
    seen.add(id);
    const clean = { id, label, type, required: !!q.required };
    const placeholder = String(q.placeholder || '').trim().slice(0, 200);
    const helpText = String(q.helpText || '').trim().slice(0, 500);
    if (placeholder) clean.placeholder = placeholder;
    if (helpText) clean.helpText = helpText;
    if (type === 'select') {
      clean.options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => String(o || '').trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 12);
      if (clean.options.length < 2) continue; // a select needs choices
    }
    if (type === 'yesno' && q.triggersUpload) {
      clean.triggersUpload = true;
      clean.uploadHeading = String(q.uploadHeading || DEFAULT_UPLOAD_HEADING).trim().slice(0, 200) || DEFAULT_UPLOAD_HEADING;
      clean.uploadInstructions = String(q.uploadInstructions || DEFAULT_UPLOAD_INSTRUCTIONS).trim().slice(0, 1000) || DEFAULT_UPLOAD_INSTRUCTIONS;
    }
    out.push(clean);
  }
  return out;
}

module.exports = {
  DEFAULT_SPEAKER_FORM, QUESTION_TYPES, sanitizeQuestions,
  DEFAULT_UPLOAD_HEADING, DEFAULT_UPLOAD_INSTRUCTIONS,
};
