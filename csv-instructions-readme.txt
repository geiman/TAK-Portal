CSV User Creation Instructions
====================================

Use this with: sample-users.csv

CSV format (DO NOT change the header line):
badge,agency,firstName,lastName,email,password,template

What each column means:
1) badge
   - User badge number / username base (do not include username suffix).
   - Letters and numbers only (no spaces or special characters).

2) agency
   - Can be either:
     a) Agency abbreviation/prefix (example: TEST), OR
     b) Agency suffix (preferred).
   - Suffix is preferred as it will lead to less abbreviation conflicts.

3) firstName
   - User first name.

4) lastName
   - User last name.

5) email
   - Optional (can be blank).
   - Must be a valid email address.
   - No spaces (example: john.doe@agency.gov is valid, john.doe @agency.gov is NOT).

6) password
   - Optional (can be blank).
   - If you enter a password, it MUST include ALL of these:
     - at least 12 characters
     - at least 1 lowercase letter
     - at least 1 uppercase letter
     - at least 1 number
     - at least 1 symbol

7) template
   - This is the user group template name to apply to the new user.
   - Example from sample file: Patrol
   - The template must already exist for that agency, or that row will fail.

Quick rules:
- Keep the first row (header) exactly as-is.
- One user per line.
- Do not add extra columns.
- Save as .csv.

Examples:
- Good row:
  1001,TEST,John,Doe,john.doe@example.org,Password!23456,Patrol
- Good row with blank password:
  1002,test,Jane,Smith,jane.smith@example.org,,Patrol
