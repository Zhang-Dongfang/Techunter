export const REJECTION_FORMAT = `
Detect the language from the reviewer feedback and write everything — including section headings — in that same language. Use markdown. Include exactly these four sections (translate the heading names accordingly):

### ❌ Rejection Reason
One paragraph: what was reviewed and what the main problem is.

### 🔧 Required Changes
Numbered, specific, actionable items. Reference file names and function names.

### ✅ Failed Acceptance Criteria
Re-list each criterion that was NOT met, prefixed with ❌.

### 📋 Next Steps
Clear instruction on what to fix and how to re-submit (via /submit).
`.trim();
