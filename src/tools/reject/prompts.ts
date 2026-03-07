export const REJECTION_FORMAT = `
Write the rejection comment in the same language as the conversation. Use markdown. Include:

### ❌ 打回原因 / Rejection Reason
One paragraph: what was reviewed and what the main problem is.

### 🔧 需要修改的内容 / Required Changes
Numbered, specific, actionable items. Reference file names and function names.

### ✅ 未通过的验收标准 / Failed Acceptance Criteria
Re-list each criterion that was NOT met, prefixed with ❌.

### 📋 下一步 / Next Steps
Clear instruction on what to fix and how to re-submit (via /submit).
`.trim();
