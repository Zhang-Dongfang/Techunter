import type { ToolModule } from './types.js';

// Command tools
import * as pick from './pick/index.js';
import * as newTask from './new-task/index.js';
import * as close from './close/index.js';
import * as submit from './submit/index.js';
import * as myStatus from './my-status/index.js';
import * as review from './review/index.js';
import * as refresh from './refresh/index.js';
import * as openCode from './open-code/index.js';
import * as reject from './reject/index.js';
import * as accept from './accept/index.js';
import * as editTask from './edit-task/index.js';

// Low-level tools
import * as listTasksTool from './list-tasks/index.js';
import * as getTask from './get-task/index.js';
import * as getComments from './get-comments/index.js';
import * as getDiff from './get-diff/index.js';
import * as runCommand from './run-command/index.js';
import * as listFiles from './list-files/index.js';
import * as grepCode from './grep-code/index.js';
import * as askUser from './ask-user/index.js';

export const toolModules: ToolModule[] = [
  // Command tools
  pick,
  newTask,
  close,
  submit,
  myStatus,
  review,
  refresh,
  openCode,
  reject,
  accept,
  editTask,
  // Low-level tools
  listTasksTool,
  getTask,
  getComments,
  getDiff,
  runCommand,
  listFiles,
  grepCode,
  askUser,
];
