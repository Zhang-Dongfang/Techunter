export const GUIDE_FORMAT = `
## Guide format
Detect the language from the task title and write everything — including section headings — in that same language. Use plain markdown, no code blocks. Be concise. Include exactly these four sections (translate the heading names accordingly):

### Task Description
Describe what needs to be done and why. Cover the background, the problem being solved, and the expected outcome.

### Files Involved
List each file path with CREATE/MODIFY, and one sentence describing what changes.

### Input / Output
What the feature/fix receives as input and what it produces or affects.

### Acceptance Criteria
Checkbox list of only the most essential testable conditions. Maximum 3 items.
`.trim();
