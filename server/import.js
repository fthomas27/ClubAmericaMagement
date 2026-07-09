const XLSX = require('xlsx');

// Parse Excel/CSV file and extract member data
function parseSpreadsheet(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);
    return data;
  } catch (error) {
    throw new Error(`Failed to parse spreadsheet: ${error.message}`);
  }
}

// Parse Google Sheets URL and fetch data
async function parseGoogleSheets(url) {
  try {
    // Extract sheet ID from various Google Sheets URL formats
    let sheetId;
    if (url.includes('/spreadsheets/d/')) {
      sheetId = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    } else if (url.includes('docs.google.com')) {
      sheetId = url.match(/d=([a-zA-Z0-9-_]+)/)?.[1];
    }

    if (!sheetId) {
      throw new Error('Invalid Google Sheets URL');
    }

    // Use CSV export endpoint (works without authentication)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    const response = await fetch(csvUrl, { timeout: 10000 });

    if (!response.ok) {
      throw new Error(`Failed to fetch Google Sheet: ${response.statusText}`);
    }

    const csv = await response.text();
    const workbook = XLSX.read(csv, { type: 'string' });
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    return data;
  } catch (error) {
    throw new Error(`Failed to parse Google Sheets: ${error.message}`);
  }
}

// Map spreadsheet columns to roster_members fields
function mapRowToMember(row) {
  const member = {};

  // Map common column names (case-insensitive)
  const columnMap = {
    firstName: ['first name', 'firstname', 'first_name', 'fn', 'given name'],
    lastName: ['last name', 'lastname', 'last_name', 'ln', 'family name'],
    email: ['email', 'email address', 'e-mail'],
    phone: ['phone', 'phone number', 'tel', 'telephone', 'mobile'],
    grade: ['grade', 'year', 'class', 'graduation year'],
    gender: ['gender', 'sex', 'pronouns'],
    roleDescription: ['role', 'position', 'title', 'role description'],
    status: ['status', 'member status'],
    notes: ['notes', 'comments', 'remarks', 'additional info'],
  };

  // Build reverse lookup of lowercase column names
  const lowerCaseRow = {};
  Object.keys(row).forEach((key) => {
    lowerCaseRow[key.toLowerCase().trim()] = row[key];
  });

  // Map columns
  Object.entries(columnMap).forEach(([targetField, aliases]) => {
    const lowerAliases = aliases.map((a) => a.toLowerCase());
    const matchedKey = Object.keys(lowerCaseRow).find((key) =>
      lowerAliases.includes(key)
    );
    if (matchedKey) {
      const value = lowerCaseRow[matchedKey];
      if (value !== null && value !== undefined && value !== '') {
        member[targetField] = String(value).trim();
      }
    }
  });

  // Validate required fields
  if (!member.firstName) {
    throw new Error('Row missing required field: firstName');
  }

  member.lastName = member.lastName || '';
  member.email = member.email || '';
  member.phone = member.phone || '';
  member.status = member.status || 'Prospect';
  member.roleDescription = member.roleDescription || '';
  member.notes = member.notes || '';

  // Parse grade as integer if present
  if (member.grade) {
    const parsed = parseInt(member.grade, 10);
    member.grade = !isNaN(parsed) ? parsed : null;
  }

  return member;
}

// Import members into database
function importMembers(db, members, options = {}) {
  const { skipDuplicates = true, onProgress = () => {} } = options;

  const existingEmails = new Set();
  const existingNames = new Set();

  if (skipDuplicates) {
    const existing = db
      .prepare('SELECT email, firstName, lastName FROM roster_members')
      .all();
    existing.forEach((e) => {
      if (e.email) existingEmails.add(e.email.toLowerCase());
      existingNames.add(`${e.firstName} ${e.lastName}`.toLowerCase());
    });
  }

  const insert = db.prepare(`
    INSERT INTO roster_members
    (firstName, lastName, email, phone, grade, gender, roleDescription, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importMany = db.transaction(() => {
    let imported = 0;
    let skipped = 0;
    const errors = [];

    members.forEach((member, index) => {
      try {
        const mapped = mapRowToMember(member);

        // Check for duplicates
        if (skipDuplicates) {
          if (mapped.email && existingEmails.has(mapped.email.toLowerCase())) {
            skipped++;
            return;
          }
          if (existingNames.has(`${mapped.firstName} ${mapped.lastName}`.toLowerCase())) {
            skipped++;
            return;
          }
        }

        insert.run(
          mapped.firstName,
          mapped.lastName,
          mapped.email,
          mapped.phone,
          mapped.grade || null,
          mapped.gender || '',
          mapped.roleDescription,
          mapped.status,
          mapped.notes
        );

        imported++;
        existingEmails.add(mapped.email.toLowerCase());
        existingNames.add(`${mapped.firstName} ${mapped.lastName}`.toLowerCase());
      } catch (error) {
        errors.push({ row: index + 1, error: error.message });
      }

      if ((index + 1) % 50 === 0) {
        onProgress(index + 1, members.length);
      }
    });

    return { imported, skipped, errors };
  });

  return importMany();
}

module.exports = {
  parseSpreadsheet,
  parseGoogleSheets,
  mapRowToMember,
  importMembers,
};
