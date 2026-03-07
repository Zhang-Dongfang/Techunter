export const GUIDE_FORMAT = `
## Guide format
Write the guide in the same language as the conversation. Use markdown. Include ALL sections:

### 📋 任务概述 / Task Overview
One paragraph: what this task is, why it matters, what done looks like.

### 🏗 架构背景 / Architecture Context
Where this task fits in the codebase. Reference specific files and modules.

### ⚙️ 技术要求 / Technical Requirements
Bullet list of constraints, patterns, APIs, and coding conventions to follow.

### 📁 涉及文件 / Files Involved
Each file path, whether to CREATE/MODIFY/DELETE, and what change is needed.

### 🪜 实现步骤 / Implementation Steps
Numbered, concrete steps referencing specific functions and file locations.

### ✅ 验收标准 / Acceptance Criteria
Checkbox list of testable conditions that must all be true before the task is done.

### ⚠️ 注意事项 / Pitfalls & Considerations
Edge cases, breaking changes, performance concerns specific to this codebase.
`.trim();
