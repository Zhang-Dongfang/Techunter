export const GUIDE_FORMAT = `
## Guide format
Write the guide in the same language as the task title. Use plain markdown, no code blocks. Be concise. Include exactly these sections:

### 任务描述
Describe what needs to be done and why. Cover the background, the problem being solved, and the expected outcome. Be as detailed as needed to make the task clear.

### 涉及文件
List each file path with CREATE/MODIFY, and one sentence describing what changes.

### 输入 / 输出
What the feature/fix receives as input and what it produces or affects.

### 验收标准
Checkbox list of only the most essential testable conditions. Maximum 3 items — include only what is strictly necessary to verify the task is done.
`.trim();
