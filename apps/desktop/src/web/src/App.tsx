import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Code2,
  Coins,
  Command,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  Github,
  Home,
  Layers3,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  Unplug,
  UserRound,
  UsersRound,
  WalletCards,
  X,
  XCircle,
} from 'lucide-react';
import type { DashboardResponse, GitHubBranch, GitHubRepositoryCandidate, LedgerEntry, Project, Task, TaskStatus, TaskSummary, User } from '@techunter/core';
import type { DesktopUpdateState } from '../../shared/desktop-contracts';
import { AgentDock } from './AgentDock';
import { ApiError, api } from './api';
import { ConexusLogin } from './ConexusLogin';
import { TaskDocument } from './TaskDocument';

type View = 'market' | 'mine' | 'review' | 'points';
type TaskView = Exclude<View, 'points'>;

const STATUS: Record<TaskStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'status-draft' },
  open: { label: '可认领', className: 'status-open' },
  active: { label: '进行中', className: 'status-active' },
  submitted: { label: '待验收', className: 'status-submitted' },
  accepted: { label: '已完成', className: 'status-accepted' },
  cancelled: { label: '已取消', className: 'status-cancelled' },
};

const TASK_VIEW_COPY: Record<TaskView, { eyebrow: string; title: string; description: string; emptyTitle: string; emptyDescription: string }> = {
  market: {
    eyebrow: 'TASK MARKET',
    title: '项目任务广场',
    description: '先选择项目，再查看和处理归属于该项目的任务。',
    emptyTitle: '还没有项目',
    emptyDescription: '从 GitHub 导入项目后，项目和任务会出现在这里。',
  },
  mine: {
    eyebrow: 'MY HUNTS',
    title: '我的项目任务',
    description: '按项目查看你正在负责和已经交付的任务。',
    emptyTitle: '还没有参与的项目',
    emptyDescription: '认领任务后，对应项目会出现在这里。',
  },
  review: {
    eyebrow: 'REVIEW QUEUE',
    title: '项目审核目录',
    description: '按项目处理等待验收的交付。',
    emptyTitle: '没有待审核项目',
    emptyDescription: '出现待验收任务时，对应项目会出现在这里。',
  },
};

const TASK_VIEW_FILTERS: Record<TaskView, Array<'all' | TaskStatus>> = {
  market: ['all', 'open', 'active', 'submitted', 'accepted'],
  mine: ['all', 'active', 'submitted', 'accepted'],
  review: ['all'],
};

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function shortId(id: string): string {
  return id.slice(0, 7).toUpperCase();
}

function relativeDate(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function Avatar({ user, small = false }: { user: User; small?: boolean }) {
  return user.avatarUrl ? (
    <img className={cn('avatar', small && 'avatar-small')} src={user.avatarUrl} alt="" />
  ) : (
    <span className={cn('avatar avatar-fallback', small && 'avatar-small')}>{user.name.slice(0, 1)}</span>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS[status];
  return <span className={cn('status-badge', meta.className)}><i />{meta.label}</span>;
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p></div>;
}

function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  return (
    <button className="task-card" onClick={onOpen}>
      <div className="task-card-top">
        <StatusBadge status={task.status} />
        <span className="task-id">TH-{shortId(task.id)}</span>
      </div>
      <div className="task-project"><Boxes size={14} />{task.projectName}{task.parentTaskId && <span className="subtask-chip">子任务</span>}</div>
      <h3>{task.title}</h3>
      <p>{task.summary || '等待 Agent 补全任务说明。'}</p>
      <div className="task-card-bottom">
        <span className="reward"><Coins size={16} />{task.rewardPoints}<em>CP</em></span>
        <span className="task-person">
          {task.assignee ? <><Avatar user={task.assignee} small />{task.assignee.name}</> : <><Clock3 size={15} />等待猎人</>}
        </span>
      </div>
    </button>
  );
}

function ProjectDirectoryCard({ project, tasks, onOpen }: { project: Project; tasks: TaskSummary[]; onOpen: () => void }) {
  const statusCounts = (['draft', 'open', 'active', 'submitted', 'accepted'] as TaskStatus[])
    .map((status) => ({ status, count: tasks.filter((task) => task.status === status).length }))
    .filter((item) => item.count > 0);
  return <button className="project-directory-card" onClick={onOpen}>
    <div className="project-directory-head"><span className="project-directory-icon"><FolderGit2 size={20} /></span><div><strong>{project.name}</strong><span>{project.repoOwner}/{project.repoName}</span></div><ArrowRight size={17} /></div>
    <p>{project.description || '共享项目，任务和交付统一归档在此目录。'}</p>
    <div className="project-directory-count"><strong>{tasks.length}</strong><span>项任务</span></div>
    <div className="project-directory-statuses">{statusCounts.length ? statusCounts.map(({ status, count }) => <span key={status} className={STATUS[status].className}><i />{STATUS[status].label} {count}</span>) : <span className="project-directory-empty">当前视图暂无任务</span>}</div>
    <div className="project-directory-foot"><span><GitBranch size={13} />{project.defaultBranch}</span><span><Coins size={13} />{project.availablePoints} CP</span></div>
  </button>;
}

function Modal({ children, onClose, wide = false }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className={cn('modal', wide && 'modal-wide')}>{children}</div>
  </div>;
}

function CollaborationRequestModal({
  project,
  githubLogin,
  onClose,
  onContinue,
}: {
  project: Project;
  githubLogin: string | null;
  onClose: () => void;
  onContinue: () => Promise<void>;
}) {
  const [result, setResult] = useState<'invited' | 'already_collaborator' | null>(null);
  const [actionUrl, setActionUrl] = useState(project.htmlUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function requestAccess() {
    setBusy(true); setError('');
    try {
      const response = await api.requestProjectCollaboration(project.id);
      setResult(response.status);
      setActionUrl(response.actionUrl);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function continueSync() {
    setBusy(true); setError('');
    try { await onContinue(); }
    catch (caught) { setError((caught as Error).message); setBusy(false); }
  }

  return <Modal onClose={busy ? () => undefined : onClose}>
    <div className="modal-head"><div><span className="eyebrow">PRIVATE REPOSITORY</span><h2>申请仓库合作者权限</h2></div><button className="icon-button" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <div className="collaboration-request">
      <div className="collaboration-repository"><span><ShieldCheck size={22} /></span><div><strong>{project.repoOwner}/{project.repoName}</strong><small>将为 GitHub 账号 @{githubLogin ?? '未连接'} 申请仓库访问权</small></div></div>
      {!result ? <p>这是一个受限仓库。Techunter 不会在你成为合作者之前下发检出凭据；提交后，GitHub 会发送一封仓库邀请。</p> : result === 'invited' ? <div className="collaboration-success"><CheckCircle2 size={19} /><div><strong>合作者邀请已发送</strong><span>请先在 GitHub 通知或邮件中接受邀请，然后回到这里继续同步。</span></div></div> : <div className="collaboration-success"><CheckCircle2 size={19} /><div><strong>GitHub 已确认合作者权限</strong><span>现在可以继续选择本地目录并同步仓库。</span></div></div>}
      {error && <div className="form-error"><XCircle size={16} />{error}</div>}
      <div className="form-actions">
        <button className="button ghost" disabled={busy} onClick={onClose}>取消</button>
        {!result ? <button className="button primary" disabled={busy || !githubLogin} onClick={() => void requestAccess()}>{busy ? <Loader2 className="spin" size={16} /> : <Github size={16} />}提交合作者申请</button> : <>
          {result === 'invited' && <a className="button secondary" href={actionUrl} target="_blank" rel="noreferrer"><Github size={16} />前往 GitHub</a>}
          <button className="button primary" disabled={busy} onClick={() => void continueSync()}>{busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}{result === 'invited' ? '我已接受，继续同步' : '继续同步'}</button>
        </>}
      </div>
    </div>
  </Modal>;
}

function ImportProjectModal({ onClose, onImported }: { onClose: () => void; onImported: (project: Project) => void }) {
  const [repositories, setRepositories] = useState<GitHubRepositoryCandidate[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.githubRepositories().then((result) => setRepositories(result.repositories)).catch((caught) => setError((caught as Error).message));
  }, []);

  const visible = repositories.filter((repository) => repository.fullName.toLowerCase().includes(search.toLowerCase()));
  async function importRepository(repository: GitHubRepositoryCandidate) {
    setBusy(repository.githubRepositoryId); setError('');
    try { onImported(await api.importProject(repository.githubRepositoryId)); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(null); }
  }

  return <Modal onClose={onClose} wide>
    <div className="modal-head"><div><span className="eyebrow">GITHUB PROJECTS</span><h2>从 GitHub 导入项目</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
    <div className="repository-picker">
      <div className="searchbox"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索有权访问的 GitHub 仓库" /></div>
      {error && <div className="form-error"><XCircle size={16} />{error}</div>}
      <div className="repository-list">{visible.map((repository) => <div key={repository.githubRepositoryId}>
        <Github size={19} /><div><strong>{repository.fullName}</strong><span>{repository.description || `${repository.visibility} repository`}</span></div>
        <button className="button secondary" disabled={repository.imported || busy !== null} onClick={() => void importRepository(repository)}>
          {busy === repository.githubRepositoryId ? <Loader2 className="spin" size={16} /> : repository.imported ? <Check size={16} /> : <Plus size={16} />}{repository.imported ? '已导入' : '导入'}
        </button>
      </div>)}</div>
      {!error && !visible.length && <EmptyState icon={<Github />} title="没有匹配的仓库" description="请确认 GitHub 账号具有仓库读取权限。" />}
    </div>
  </Modal>;
}

function CreateTaskModal({
  projects,
  defaultProjectId,
  parent,
  onClose,
  onCreated,
}: {
  projects: Project[];
  defaultProjectId?: string;
  parent?: Task | null;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const [projectId, setProjectId] = useState(parent?.projectId ?? defaultProjectId ?? projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const draft = parent
        ? await api.createSubtask(parent.id, { projectId, title, description })
        : await api.createTask({ projectId, title, description });
      const analyzed = await api.analyze(draft.id);
      onCreated(analyzed.task);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <Modal onClose={onClose}>
    <div className="modal-head">
      <div><span className="eyebrow">{parent ? 'DELEGATE' : 'NEW HUNT'}</span><h2>{parent ? '发布子任务' : '发布一个新任务'}</h2></div>
      <button className="icon-button" onClick={onClose}><X size={20} /></button>
    </div>
    {parent && <div className="parent-banner"><GitBranch size={17} /><div><strong>父任务</strong><span>{parent.title}</span></div></div>}
    <form className="form-stack" onSubmit={submit}>
      <label>所属项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={Boolean(parent)}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.repoOwner}/{project.repoName}</option>)}
      </select></label>
      <label>任务标题<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：为任务认领增加租约机制" minLength={3} required /></label>
      <label>任务说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说清楚背景、问题和期望结果。Agent 会补全验收标准、文件范围和估价。" minLength={10} rows={7} required /></label>
      <div className="agent-hint"><Sparkles size={18} /><span>创建后，Task Spec Agent 会直接读取 GitHub 上选定的源码分支，生成任务说明、Scope 与建议贡献点，无需先同步到本机。</span></div>
      {error && <div className="form-error"><XCircle size={16} />{error}</div>}
      <div className="form-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? <><Loader2 className="spin" size={17} />Agent 分析中</> : <>创建并分析<ArrowRight size={17} /></>}</button></div>
    </form>
  </Modal>;
}

function TerminalPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const [command, setCommand] = useState('git status');
  const [workingDir, setWorkingDir] = useState(cwd);
  const [output, setOutput] = useState('Techunter Local Shell\n');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const desktop = window.techunterDesktop;

  useEffect(() => {
    if (!desktop) return;
    const offOutput = desktop.onOutput((event) => {
      if (!sessionId || event.sessionId === sessionId) setOutput((value) => value + event.data);
    });
    const offExit = desktop.onExit((event) => {
      if (!sessionId || event.sessionId === sessionId) {
        setOutput((value) => `${value}\n[process exited ${event.exitCode ?? 'unknown'}]\n`);
        setSessionId(null);
      }
    });
    return () => { offOutput(); offExit(); };
  }, [desktop, sessionId]);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!desktop || !command.trim()) return;
    setOutput((value) => `${value}\n> ${command}\n`);
    const result = await desktop.run({ command, cwd: workingDir });
    setSessionId(result.sessionId);
  }

  return <Modal onClose={onClose} wide>
    <div className="terminal-window">
      <div className="terminal-titlebar"><span className="terminal-lights"><i /><i /><i /></span><span><TerminalSquare size={15} />本地命令台</span><button onClick={onClose}><X size={17} /></button></div>
      <div className="terminal-cwd">cwd <input value={workingDir} onChange={(event) => setWorkingDir(event.target.value)} /></div>
      <pre>{desktop ? output : '本地命令台仅在 Electron 桌面端可用。'}</pre>
      <form className="terminal-input" onSubmit={run}><span>❯</span><input value={command} onChange={(event) => setCommand(event.target.value)} disabled={!desktop || Boolean(sessionId)} /><button disabled={!desktop || Boolean(sessionId)}>{sessionId ? '运行中' : '执行'}</button>{sessionId && <button type="button" className="danger-text" onClick={() => desktop?.cancel(sessionId)}>终止</button>}</form>
    </div>
  </Modal>;
}

function TaskDetail({
  task,
  me,
  projects,
  onClose,
  onChanged,
  onRemoved,
  onOpenTask,
}: {
  task: Task;
  me: User;
  projects: Project[];
  onClose: () => void;
  onChanged: (task: Task) => void;
  onRemoved: (result: { id: string; disposition: 'deleted' | 'cancelled' }) => void;
  onOpenTask: (id: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reward, setReward] = useState(task.rewardPoints);
  const [subtask, setSubtask] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [testOutput, setTestOutput] = useState('');
  const [changeReason, setChangeReason] = useState('请根据验收标准补充实现与测试。');
  const [localPath, setLocalPath] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState(false);

  const project = projects.find((candidate) => candidate.id === task.projectId);

  useEffect(() => {
    window.techunterDesktop?.locate(task.id).then((result) => setLocalPath(result.path ?? '')).catch(() => undefined);
  }, [task.id]);

  async function action(name: string, fn: () => Promise<Task | unknown>) {
    setBusy(name); setError('');
    try {
      await fn();
      onChanged(await api.task(task.id));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy('');
    }
  }

  const mine = task.assignee?.id === me.id;
  const canReview = ['admin', 'maintainer'].includes(me.role) && !mine;
  const submission = task.latestSubmission;

  async function provisionWorkspace() {
    const desktop = window.techunterDesktop;
    if (!desktop) throw new Error('自动同步和环境配置仅在 Techunter Desktop 中可用。');
    if (!project) throw new Error('找不到任务所属项目。');
    const checkout = await api.checkoutAuthorization(project.id);
    const projectLocation = await desktop.locateProject(project.id);
    if (!projectLocation.path) {
      const synced = await desktop.syncProject({ project, accessToken: checkout.token });
      if (!synced) throw new Error('已取消本地目录选择，尚未准备任务工作环境。');
    }
    const identity = await desktop.identity();
    const workspace = await api.workspace(task.id, identity);
    await api.updateWorkspace(workspace.id, { status: 'provisioning' });
    try {
      const result = await desktop.provision({ project, task, accessToken: checkout.token });
      setLocalPath(result.path);
      await api.updateWorkspace(workspace.id, { status: 'running', headSha: result.headSha, setupLog: result.setupLog, error: null });
    } catch (caught) {
      await api.updateWorkspace(workspace.id, { status: 'failed', error: (caught as Error).message }).catch(() => undefined);
      throw caught;
    }
  }

  async function submitDelivery() {
    const desktop = window.techunterDesktop;
    if (!desktop) throw new Error('交付必须从准备该环境的 Techunter Desktop 提交。');
    const changes = await desktop.collectChanges({ task });
    setLocalPath(changes.path);
    return api.submit(task.id, { summary, testOutput, files: changes.files });
  }

  async function removeTask() {
    setBusy('remove');
    setError('');
    try {
      onRemoved(await api.removeTask(task.id));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy('');
    }
  }

  const canRemove = me.role === 'admin' && !['accepted', 'cancelled'].includes(task.status);
  const removeLabel = task.status === 'draft' ? '删除草稿' : '取消并移除任务';

  return <>
    <Modal onClose={onClose} wide>
      <div className="detail-shell">
        <div className="detail-head">
          <div className="detail-head-main"><div className="detail-meta"><StatusBadge status={task.status} /><span>TH-{shortId(task.id)}</span><span>·</span><span>{task.projectName}</span></div><h2>{task.title}</h2><p>{task.summary || task.description}</p></div>
          <button className="icon-button" onClick={onClose}><X size={21} /></button>
        </div>

        <div className="detail-grid">
          <main className="detail-main">
            <TaskDocument task={task} />
            <section><div className="section-title"><ShieldCheck size={18} /><h3>验收标准</h3></div>{task.acceptanceCriteria.length ? <ul className="criteria-list">{task.acceptanceCriteria.map((item) => <li key={item}><span><Check size={14} /></span>{item}</li>)}</ul> : <p className="muted">等待 Agent 分析。</p>}</section>

            {task.scope && <section><div className="section-title"><FileCode2 size={18} /><h3>任务文件范围</h3><span className="revision">REV {task.scope.revision}</span></div><div className="scope-columns"><div><h4>可编辑</h4>{task.scope.editablePaths.map((file) => <code key={file}>{file}</code>)}</div><div><h4>只读上下文</h4>{task.scope.readonlyPaths.length ? task.scope.readonlyPaths.map((file) => <code key={file}>{file}</code>) : <span className="muted">无</span>}</div></div><details className="environment-details"><summary>本机 Agent 环境计划</summary><dl><dt>准备</dt><dd>{task.scope.environment.setupCommands.join(' · ') || '由 Agent 自动探测'}</dd><dt>测试</dt><dd>{task.scope.environment.testCommands.join(' · ') || '未配置'}</dd><dt>网络</dt><dd>{task.scope.environment.networkAllowlist.join(' · ') || '按本机策略'}</dd></dl></details></section>}

            {task.children.length > 0 && <section><div className="section-title"><Layers3 size={18} /><h3>子任务</h3><span className="revision">{task.children.length}</span></div><div className="child-list">{task.children.map((child) => <button key={child.id} onClick={() => onOpenTask(child.id)}><StatusBadge status={child.status} /><span>{child.title}</span><strong>{child.rewardPoints} CP</strong><ArrowRight size={16} /></button>)}</div></section>}

            {task.workspace && <section><div className="section-title"><Command size={18} /><h3>本机工作环境</h3><span className={cn('workspace-state', task.workspace.status)}>{task.workspace.status}</span></div><div className="workspace-card"><div><span>{task.workspace.deviceLabel}</span><code>{localPath || task.workspace.error || 'Agent 正在准备仓库与依赖'}</code></div>{localPath && <div className="workspace-actions"><button className="button secondary" onClick={() => setTerminal(true)}><TerminalSquare size={16} />命令台</button><button className="button ghost" onClick={() => window.techunterDesktop?.run({ command: 'code .', cwd: localPath })}><Code2 size={16} />VS Code</button></div>}</div>{task.workspace.setupLog && <details className="delivery-doc"><summary>环境准备日志</summary><pre>{task.workspace.setupLog}</pre></details>}</section>}

            {submission?.review && <section><div className="review-hero"><div className={cn('score-ring', submission.review.verdict === 'approved' ? 'good' : 'warn')}><strong>{submission.review.score}</strong><span>/100</span></div><div><span className="eyebrow">AI REVIEW</span><h3>{submission.review.verdict === 'approved' ? '自动预审通过' : '需要继续修改'}</h3><p>{submission.review.summary}</p></div></div><div className="finding-list">{submission.review.findings.map((finding) => <div key={finding.criterion}><span className={finding.passed ? 'finding-pass' : 'finding-fail'}>{finding.passed ? <Check size={15} /> : <X size={15} />}</span><div><strong>{finding.criterion}</strong><p>{finding.evidence}</p></div></div>)}</div>{submission.review.risks.length > 0 && <div className="risk-box"><strong>风险提示</strong>{submission.review.risks.map((risk) => <p key={risk}>· {risk}</p>)}</div>}<details className="delivery-doc"><summary>查看 Agent 交付文档</summary><pre>{submission.review.deliveryDocument}</pre></details>{submission.pullRequestUrl && <a className="pr-link" href={submission.pullRequestUrl} target="_blank" rel="noreferrer"><Github size={17} />打开 Pull Request<ExternalLink size={14} /></a>}</section>}
          </main>

          <aside className="detail-side">
            <div className="reward-panel"><span>任务赏金</span><strong>{task.rewardPoints}<em> CP</em></strong><small>验收后自动结算</small></div>
            <dl className="facts"><dt>发布者</dt><dd><Avatar user={task.publisher} small />{task.publisher.name}</dd><dt>执行者</dt><dd>{task.assignee ? <><Avatar user={task.assignee} small />{task.assignee.name}</> : '尚未认领'}</dd><dt>目标分支</dt><dd><code>{task.targetBranch}</code></dd><dt>基础版本</dt><dd><code>{task.baseSha ? task.baseSha.slice(0, 8) : 'working tree'}</code></dd><dt>更新时间</dt><dd>{relativeDate(task.updatedAt)}</dd></dl>
            {task.githubIssueUrl && <a className="github-box" href={task.githubIssueUrl} target="_blank" rel="noreferrer"><Github size={18} /><span><small>GitHub Issue</small>#{task.githubIssueNumber}</span><ExternalLink size={15} /></a>}

            <div className="action-stack">
              {task.status === 'draft' && <><button className="button secondary full" disabled={Boolean(busy)} onClick={() => action('analyze', async () => (await api.analyze(task.id)).task)}>{busy === 'analyze' ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}重新分析</button><label className="reward-input">发布赏金<div><input type="number" min={1} value={reward} onChange={(event) => setReward(Number(event.target.value))} /><span>CP</span></div></label><button className="button primary full" disabled={Boolean(busy)} onClick={() => action('publish', () => api.publish(task.id, reward))}>{busy === 'publish' ? <Loader2 className="spin" size={17} /> : <Activity size={17} />}确认并发布</button></>}
              {task.status === 'open' && <button className="button primary full" disabled={Boolean(busy)} onClick={() => action('claim', () => api.claim(task.id))}>{busy === 'claim' ? <Loader2 className="spin" size={17} /> : <CrosshairIcon />}认领这个任务</button>}
              {task.status === 'active' && mine && <><button className="button primary full" disabled={Boolean(busy)} onClick={() => action('workspace', provisionWorkspace)}>{busy === 'workspace' ? <Loader2 className="spin" size={17} /> : <Command size={17} />}{localPath ? '同步并检查环境' : '让 Agent 准备环境'}</button><button className="button secondary full" onClick={() => setSubtask(true)}><GitBranch size={17} />发布子任务</button>{task.workspace?.status === 'running' && localPath && <button className="button secondary full" onClick={() => setSubmitOpen((value) => !value)}><CheckCircle2 size={17} />提交交付</button>}<button className="button ghost full" disabled={Boolean(busy)} onClick={() => action('release', () => api.release(task.id))}>释放任务</button></>}
              {task.status === 'submitted' && submission?.status === 'approved' && canReview && <><button className="button primary full" disabled={Boolean(busy)} onClick={() => action('accept', () => api.accept(submission.id))}>{busy === 'accept' ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}验收并结算</button><textarea className="compact-textarea" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} rows={3} /><button className="button danger full" disabled={Boolean(busy)} onClick={() => action('changes', () => api.requestChanges(submission.id, changeReason))}><XCircle size={17} />要求修改</button></>}
              {task.status === 'accepted' && <div className="done-panel"><CheckCircle2 size={22} /><div><strong>任务已完成</strong><span>贡献点已进入执行者账户</span></div></div>}
              {canRemove && (!removeConfirm
                ? <button className="button danger full" disabled={Boolean(busy)} onClick={() => setRemoveConfirm(true)}><Trash2 size={16} />{removeLabel}</button>
                : <div className="task-remove-confirm">
                  <strong>{task.status === 'draft' ? '永久删除这个草稿？' : '确认取消并移除这个任务？'}</strong>
                  <p>{task.status === 'draft' ? '草稿将永久删除，此操作无法恢复。' : '任务会从市场移除，GitHub Issue 与未合并 PR 将关闭，未结算贡献点会退回项目。'}</p>
                  <div><button className="button ghost" disabled={Boolean(busy)} onClick={() => setRemoveConfirm(false)}>返回</button><button className="button danger" disabled={Boolean(busy)} onClick={() => void removeTask()}>{busy === 'remove' ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}{removeLabel}</button></div>
                </div>)}
            </div>
            {error && <div className="form-error"><XCircle size={16} />{error}</div>}
          </aside>
        </div>

        {submitOpen && <div className="inline-form"><div className="section-title"><Bot size={18} /><h3>提交给 Review Agent</h3></div><label>交付摘要<textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} placeholder="完成了什么、有哪些关键决策？" /></label><label>测试输出<textarea value={testOutput} onChange={(event) => setTestOutput(event.target.value)} rows={5} placeholder="粘贴 npm test、typecheck 或其他验证结果。" /></label><div className="form-actions"><button className="button ghost" onClick={() => setSubmitOpen(false)}>取消</button><button className="button primary" disabled={Boolean(busy) || summary.trim().length < 3} onClick={() => action('submit', submitDelivery)}>{busy === 'submit' ? <><Loader2 className="spin" size={17} />审查中</> : <><Bot size={17} />提交并自动审查</>}</button></div></div>}
      </div>
    </Modal>
    {subtask && <CreateTaskModal projects={projects} parent={task} onClose={() => setSubtask(false)} onCreated={(created) => { setSubtask(false); onOpenTask(created.id); }} />}
    {terminal && <TerminalPanel cwd={localPath} onClose={() => setTerminal(false)} />}
  </>;
}

function CrosshairIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2"/></svg>;
}

function UpdateControl({ state, onAction }: { state: DesktopUpdateState | null; onAction: () => void }) {
  if (!state) return <span className="version">WEB CLIENT</span>;
  const busy = state.status === 'checking' || state.status === 'available' || state.status === 'downloading';
  const actionable = state.status === 'downloaded' || state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error';
  const label = state.status === 'downloaded'
    ? `v${state.availableVersion ?? state.currentVersion} 已就绪`
    : state.status === 'downloading'
      ? `正在下载 v${state.availableVersion ?? ''}`
      : state.status === 'available'
        ? `发现 v${state.availableVersion ?? ''}`
        : state.status === 'checking'
          ? '正在检查更新'
          : state.status === 'error'
            ? '更新检查失败'
            : `v${state.currentVersion}`;
  const detail = state.status === 'downloaded'
    ? '点击重启并安装'
    : state.status === 'downloading'
      ? `${state.progress ?? 0}%`
      : state.status === 'available'
        ? '正在准备下载'
        : state.status === 'checking'
          ? '连接 GitHub Releases'
          : state.status === 'error'
            ? '点击重试'
            : state.status === 'disabled'
              ? 'DEV · 自动更新已关闭'
              : state.status === 'up-to-date'
                ? '已是最新版本 · 点击复查'
                : '点击检查更新';

  return <button type="button" className={cn('update-control', state.status)} disabled={!actionable} onClick={onAction} title={state.message}>
    {busy ? <Loader2 className="spin" size={15} /> : state.status === 'downloaded' ? <CheckCircle2 size={15} /> : <RefreshCw size={15} />}
    <span><strong>{label}</strong><small>{detail}</small></span>
    {state.status === 'downloading' && <i style={{ width: `${state.progress ?? 0}%` }} />}
  </button>;
}

function PointsView({ points, entries }: { points: number; entries: LedgerEntry[] }) {
  const incoming = entries.filter((entry) => entry.toLabel !== '系统发行').reduce((sum, entry) => sum + entry.amount, 0);
  return <div className="points-layout"><div className="balance-hero"><div className="balance-glow" /><span>可用贡献点</span><strong>{points.toLocaleString()} <em>CP</em></strong><p>企业内部贡献记录，不与现金兑换</p><div className="balance-stats"><div><small>历史流入</small><b>+{incoming}</b></div><div><small>交易笔数</small><b>{entries.length}</b></div></div></div><div className="ledger-panel"><div className="panel-title"><div><span className="eyebrow">LEDGER</span><h3>贡献点明细</h3></div><ShieldCheck size={22} /></div>{entries.length ? <div className="ledger-list">{entries.map((entry) => <div key={entry.id}><span className={cn('ledger-icon', entry.type === 'task_settlement' && 'income')}><Coins size={17} /></span><div><strong>{entry.memo}</strong><small>{entry.fromLabel} → {entry.toLabel} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</small></div><b>+{entry.amount} CP</b></div>)}</div> : <EmptyState icon={<WalletCards />} title="还没有账单" description="完成第一个任务后，贡献点会出现在这里。" />}</div></div>;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [view, setView] = useState<View>('market');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectLocation, setProjectLocation] = useState<{ projectId: string; path: string } | null>(null);
  const [projectLocationChecking, setProjectLocationChecking] = useState(false);
  const [projectSyncing, setProjectSyncing] = useState(false);
  const [projectSyncNotice, setProjectSyncNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [collaborationProject, setCollaborationProject] = useState<Project | null>(null);
  const [projectBranches, setProjectBranches] = useState<GitHubBranch[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchSwitching, setBranchSwitching] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [branchReloadKey, setBranchReloadKey] = useState(0);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchControlRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pointsData, setPointsData] = useState<{ available: number; entries: LedgerEntry[] } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [githubConnecting, setGitHubConnecting] = useState(false);
  const [githubError, setGitHubError] = useState('');
  const [conexusConnecting, setConexusConnecting] = useState(false);
  const [conexusError, setConexusError] = useState('');
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    const desktop = window.techunterDesktop;
    if (!desktop) return;
    let active = true;
    const unsubscribe = desktop.onUpdateState((state) => { if (active) setUpdateState(state); });
    desktop.getUpdateState().then((state) => { if (active) setUpdateState(state); }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api.dashboard();
      setDashboard(data);
      setSelectedProjectId((current) => data.projects.some((project) => project.id === current) ? current : '');
      setAuthRequired(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setDashboard(null);
        setAuthRequired(true);
        return;
      }
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!branchMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!branchControlRef.current?.contains(event.target as Node)) setBranchMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBranchMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [branchMenuOpen]);

  useEffect(() => { setBranchMenuOpen(false); }, [selectedProjectId]);

  useEffect(() => {
    const authorizationRequired = () => { void load(); };
    window.addEventListener('techunter:conexus-authorization-required', authorizationRequired);
    return () => window.removeEventListener('techunter:conexus-authorization-required', authorizationRequired);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setProjectBranches([]);
    setBranchError('');
    setBranchLoading(false);
    if (!selectedProjectId || !dashboard?.runtime.githubConnected) return () => { cancelled = true; };
    setBranchLoading(true);
    api.projectBranches(selectedProjectId).then((result) => {
      if (cancelled) return;
      setProjectBranches(result.branches);
      setDashboard((current) => current ? {
        ...current,
        projects: current.projects.map((project) => project.id === selectedProjectId
          ? { ...project, sourceBranch: result.sourceBranch }
          : project),
      } : current);
    }).catch((caught) => {
      if (!cancelled) setBranchError((caught as Error).message);
    }).finally(() => {
      if (!cancelled) setBranchLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, dashboard?.runtime.githubConnected, branchReloadKey]);

  useEffect(() => {
    if (view === 'points') api.points().then((result) => setPointsData({ available: result.available, entries: result.entries })).catch((caught) => setError((caught as Error).message));
  }, [view, dashboard]);

  useEffect(() => {
    let active = true;
    setProjectLocation(null);
    setProjectSyncNotice(null);
    if (!selectedProjectId || !window.techunterDesktop) {
      setProjectLocationChecking(false);
      return () => { active = false; };
    }
    setProjectLocationChecking(true);
    window.techunterDesktop.locateProject(selectedProjectId)
      .then((result) => {
        if (active && result.path) setProjectLocation({ projectId: selectedProjectId, path: result.path });
      })
      .catch((caught) => {
        if (active) setProjectSyncNotice({ tone: 'error', text: (caught as Error).message });
      })
      .finally(() => { if (active) setProjectLocationChecking(false); });
    return () => { active = false; };
  }, [selectedProjectId]);

  async function openTask(id: string) {
    setError('');
    try { setSelectedTask(await api.task(id)); } catch (caught) { setError((caught as Error).message); }
  }

  async function logout() {
    await api.logout();
    setProfileOpen(false);
    setDashboard(null);
    setAuthRequired(true);
  }

  async function refreshConexus() {
    if (!window.techunterDesktop || conexusConnecting) return;
    setConexusConnecting(true);
    setConexusError('');
    try {
      const config = await api.conexusConfig();
      const authorization = await window.techunterDesktop.authorizeConexus(config);
      await api.refreshConexus(authorization, window.location.origin);
      await load();
      setProfileOpen(false);
    } catch (caught) {
      setConexusError((caught as Error).message);
    } finally {
      setConexusConnecting(false);
    }
  }

  async function connectGitHub() {
    if (!window.techunterDesktop || githubConnecting) return;
    setGitHubConnecting(true);
    setGitHubError('');
    try {
      const { authorizationUrl } = await api.beginGitHubAuthorization();
      await window.techunterDesktop.openAuthenticationUrl(authorizationUrl);
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        const { githubConnected } = await api.me();
        if (!githubConnected) continue;
        await load();
        setProfileOpen(false);
        return;
      }
      throw new Error('等待 GitHub 浏览器授权超时，请重试。');
    } catch (caught) {
      setGitHubError((caught as Error).message);
    } finally {
      setGitHubConnecting(false);
    }
  }

  async function disconnectGitHub() {
    if (githubConnecting || !window.confirm('断开 GitHub 并撤销 Techunter 的 GitHub 授权？')) return;
    setGitHubConnecting(true);
    setGitHubError('');
    try {
      await api.disconnectGitHub();
      await load();
      setProfileOpen(false);
    } catch (caught) {
      setGitHubError((caught as Error).message);
    } finally {
      setGitHubConnecting(false);
    }
  }

  async function handleUpdateAction() {
    const desktop = window.techunterDesktop;
    if (!desktop || !updateState) return;
    try {
      if (updateState.status === 'downloaded') {
        await desktop.installUpdate();
        return;
      }
      setUpdateState(await desktop.checkForUpdates());
    } catch (caught) {
      setUpdateState({
        ...updateState,
        status: 'error',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  async function syncProjectLocally(project: Project, accessToken?: string) {
    const desktop = window.techunterDesktop;
    if (!desktop) throw new Error('仓库同步仅在 Techunter Desktop 中可用。');
    const result = await desktop.syncProject({ project, accessToken });
    if (!result) return;
    setProjectLocation({ projectId: project.id, path: result.path });
    const outcome = result.outcome === 'cloned' ? '仓库已克隆' : result.outcome === 'updated' ? '仓库已更新' : '远程内容已获取';
    setProjectSyncNotice({
      tone: 'success',
      text: `${outcome}到 ${result.path}${result.workingTreeClean ? '' : '；检测到本地改动，未覆盖当前工作区。'}`,
    });
  }

  async function beginProjectSync(project: Project) {
    if (projectSyncing) return;
    setProjectSyncing(true);
    setProjectSyncNotice(null);
    try {
      let accessToken: string | undefined;
      if (project.visibility !== 'public') {
        try {
          accessToken = (await api.checkoutAuthorization(project.id)).token;
        } catch (caught) {
          if (caught instanceof ApiError && caught.code === 'GITHUB_COLLABORATOR_REQUIRED') {
            setCollaborationProject(project);
            return;
          }
          throw caught;
        }
      }
      await syncProjectLocally(project, accessToken);
    } catch (caught) {
      setProjectSyncNotice({ tone: 'error', text: (caught as Error).message });
    } finally {
      setProjectSyncing(false);
    }
  }

  async function continuePrivateProjectSync(project: Project) {
    const checkout = await api.checkoutAuthorization(project.id);
    setCollaborationProject(null);
    setProjectSyncing(true);
    try {
      await syncProjectLocally(project, checkout.token);
    } catch (caught) {
      setProjectSyncNotice({ tone: 'error', text: (caught as Error).message });
    } finally {
      setProjectSyncing(false);
    }
  }

  async function switchProjectBranch(sourceBranch: string) {
    if (!selectedProjectId || branchSwitching) return;
    setBranchSwitching(true);
    setBranchError('');
    try {
      const updated = await api.switchProjectBranch(selectedProjectId, sourceBranch);
      setDashboard((current) => current ? {
        ...current,
        projects: current.projects.map((project) => project.id === updated.id ? updated : project),
      } : current);
      setSelectedTask(null);
      setProjectSyncNotice({ tone: 'success', text: `任务源码分支已切换至 ${updated.sourceBranch}，后续任务将使用新的提交基线。` });
    } catch (caught) {
      setBranchError((caught as Error).message);
    } finally {
      setBranchSwitching(false);
    }
  }

  const visibleTasks = useMemo(() => {
    if (!dashboard) return [];
    const normalizedSearch = search.trim().toLowerCase();
    return dashboard.tasks.filter((task) => {
      if (view === 'mine' && task.assignee?.id !== dashboard.me.id) return false;
      if (view === 'review' && task.status !== 'submitted') return false;
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      const project = dashboard.projects.find((candidate) => candidate.id === task.projectId);
      if (normalizedSearch && !`${task.title} ${task.summary} ${task.projectName} ${project?.description ?? ''} ${project?.repoOwner ?? ''} ${project?.repoName ?? ''}`.toLowerCase().includes(normalizedSearch)) return false;
      return true;
    });
  }, [dashboard, view, statusFilter, search]);

  const projectEntries = useMemo(() => {
    if (!dashboard || view === 'points') return [];
    const normalizedSearch = search.trim().toLowerCase();
    return dashboard.projects.map((project) => ({
      project,
      tasks: visibleTasks.filter((task) => task.projectId === project.id),
      projectMatches: !normalizedSearch || `${project.name} ${project.description} ${project.repoOwner} ${project.repoName}`.toLowerCase().includes(normalizedSearch),
    })).filter((entry) => {
      if (entry.tasks.length) return true;
      return view === 'market' && statusFilter === 'all' && entry.projectMatches;
    });
  }, [dashboard, search, statusFilter, view, visibleTasks]);

  if (loading && !dashboard) return <div className="boot-screen"><div className="brand-mark"><CrosshairIcon /></div><h1>TECHUNTER</h1><Loader2 className="spin" /></div>;
  if (authRequired) return <ConexusLogin onAuthorized={() => { void load(); }} />;
  if (!dashboard) return <div className="boot-screen error-screen"><XCircle /><h2>无法启动 Techunter</h2><p>{error}</p><button className="button primary" onClick={load}>重试</button></div>;

  const nav = [
    { id: 'market' as const, label: '任务广场', icon: <Home size={19} /> },
    { id: 'mine' as const, label: '我的任务', icon: <UserRound size={19} /> },
    { id: 'review' as const, label: '审核中心', icon: <ShieldCheck size={19} />, count: dashboard.reviewCount },
    { id: 'points' as const, label: '贡献点', icon: <WalletCards size={19} /> },
  ];
  const selectedProject = dashboard.projects.find((project) => project.id === selectedProjectId);
  const selectedProjectTasks = selectedProject ? visibleTasks.filter((task) => task.projectId === selectedProject.id) : [];
  const taskView: TaskView | null = view === 'points' ? null : view;
  const viewCopy = taskView ? TASK_VIEW_COPY[taskView] : null;
  const viewFilters = taskView ? TASK_VIEW_FILTERS[taskView] : [];
  const activeSourceBranch = selectedProject?.sourceBranch || selectedProject?.defaultBranch || '';
  const branchOptions = selectedProject && !projectBranches.some((branch) => branch.name === activeSourceBranch)
    ? [{ name: activeSourceBranch, sha: selectedProject.headSha, protected: false, isDefault: activeSourceBranch === selectedProject.defaultBranch }, ...projectBranches]
    : projectBranches;
  const canSwitchProjectBranch = ['admin', 'maintainer'].includes(dashboard.me.role);
  const branchControlDisabled = !canSwitchProjectBranch || branchLoading || branchSwitching || !dashboard.runtime.githubConnected;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="logo"><div className="brand-mark"><CrosshairIcon /></div><div><strong>TECHUNTER</strong><span>科技猎人</span></div></div>
      <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setSelectedProjectId(''); setSelectedTask(null); setStatusFilter('all'); }}>{item.icon}<span>{item.label}</span>{Boolean(item.count) && <b>{item.count}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="secure-note"><ShieldCheck size={17} /><div><strong>企业内部模式</strong><span>限定文件 · 全程审计</span></div></div><UpdateControl state={updateState} onAction={() => { void handleUpdateAction(); }} /></div>
    </aside>

    <main className="content">
      <header className="topbar"><div className="searchbox"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务、项目或猎人..." /><kbd>⌘ K</kbd></div><div className="top-actions"><div className={cn('core-pill', dashboard.runtime.agentConfigured && dashboard.runtime.githubConfigured && dashboard.runtime.githubConnected ? 'ready' : 'missing')} title={`模型：${dashboard.runtime.agentModel ?? '未授权'} · GitHub：${dashboard.runtime.githubConnected ? '已连接' : '未连接'}`}><Bot size={15} /><i /><span>{dashboard.runtime.modelAccessMode === 'conexus' ? 'CONEXUS' : 'DIRECT'}</span></div><div className="points-pill"><Coins size={17} /><strong>{dashboard.myAvailablePoints}</strong><span>CP</span></div><button className="refresh-button" onClick={() => { setBranchReloadKey((value) => value + 1); void load(); }}><RefreshCw size={17} /></button><div className="profile-wrap"><button className="profile-button" onClick={() => setProfileOpen((value) => !value)}><Avatar user={dashboard.me} /><div><strong>{dashboard.me.name}</strong><span>{dashboard.me.role}</span></div><ChevronDown size={15} /></button>{profileOpen && <div className="profile-menu">
        <span>{dashboard.me.email ?? `@${dashboard.me.login}`}</span>
        {dashboard.runtime.conexusAuthorizationRequired && <button disabled={conexusConnecting} onClick={() => { void refreshConexus(); }}>{conexusConnecting ? <Loader2 className="spin" size={14} /> : <KeyRound size={14} />}<div><strong>{conexusConnecting ? '等待浏览器授权' : '续期 Conexus 模型授权'}</strong>{conexusError && <small>{conexusError}</small>}</div></button>}
        {!dashboard.runtime.githubConnected && dashboard.runtime.githubAccountLinkConfigured && <button disabled={githubConnecting} onClick={() => { void connectGitHub(); }}>{githubConnecting ? <Loader2 className="spin" size={14} /> : <Github size={14} />}<div><strong>{githubConnecting ? '等待浏览器授权' : dashboard.me.githubLogin ? '重新连接 GitHub' : '使用浏览器连接 GitHub'}</strong>{githubError && <small>{githubError}</small>}</div></button>}
        {!dashboard.runtime.githubConnected && !dashboard.runtime.githubAccountLinkConfigured && <span>GitHub 尚未连接</span>}
        {dashboard.runtime.githubConnected && <><span>GitHub · @{dashboard.me.githubLogin}</span><button disabled={githubConnecting} onClick={() => { void disconnectGitHub(); }}><Unplug size={14} /><div><strong>断开 GitHub</strong>{githubError && <small>{githubError}</small>}</div></button></>}
        <button onClick={() => { void logout(); }}><LogOut size={14} /><div><strong>退出登录</strong></div></button>
      </div>}</div></div></header>

      <div className="page">
        {dashboard.runtime.conexusAuthorizationRequired && <div className="authorization-banner"><KeyRound size={19} /><div><strong>模型授权已到期</strong><span>Techunter 仍保持登录，任务与 GitHub 功能不受影响。续期后可继续使用 Agent。</span>{conexusError && <small>{conexusError}</small>}</div><button className="button secondary" disabled={conexusConnecting} onClick={() => { void refreshConexus(); }}>{conexusConnecting ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}{conexusConnecting ? '等待浏览器授权' : '续期授权'}</button></div>}
        {taskView && viewCopy && <>
          {!selectedProject ? <>
            <div className="page-head"><div><span className="eyebrow">{viewCopy.eyebrow}</span><h1>{viewCopy.title}</h1><p>{viewCopy.description}</p></div>{taskView === 'market' && <button className="button primary" onClick={() => setImportOpen(true)}><Plus size={18} />导入 GitHub 项目</button>}</div>
            <div className="market-toolbar"><div className="filter-tabs">{viewFilters.map((status) => <button key={status} className={statusFilter === status ? 'active' : ''} onClick={() => setStatusFilter(status)}>{status === 'all' ? '全部' : STATUS[status].label}</button>)}</div><div className="market-count"><FolderGit2 size={16} />{projectEntries.length} 个项目 · {visibleTasks.length} 个任务</div></div>
            {error && <div className="page-error"><XCircle size={17} />{error}</div>}
            {projectEntries.length ? <div className="project-directory-grid">{projectEntries.map(({ project, tasks }) => <ProjectDirectoryCard key={project.id} project={project} tasks={tasks} onOpen={() => { setSelectedProjectId(project.id); setSelectedTask(null); }} />)}</div> : <EmptyState icon={<FolderGit2 />} title={search || statusFilter !== 'all' ? '没有匹配的项目' : viewCopy.emptyTitle} description={search || statusFilter !== 'all' ? '调整搜索或筛选条件后重试。' : viewCopy.emptyDescription} />}
          </> : <>
            <button className="project-directory-back" onClick={() => { setSelectedProjectId(''); setSelectedTask(null); }}><ArrowLeft size={15} />返回项目目录</button>
            <div className="project-context-head">
              <div className="project-context-icon"><FolderGit2 size={24} /></div>
              <div className="project-context-main"><span className="eyebrow">{viewCopy.eyebrow} · PROJECT</span><h1>{selectedProject.name}</h1><p>{selectedProject.description || '该项目的任务、交付和审核记录。'}</p><div><span><Github size={14} />{selectedProject.repoOwner}/{selectedProject.repoName}</span><span><GitBranch size={14} />默认分支 {selectedProject.defaultBranch}</span><span><Coins size={14} />{selectedProject.availablePoints} CP</span></div></div>
              <div className="project-context-actions">
                <div ref={branchControlRef} className={cn('project-branch-control', (branchLoading || branchSwitching) && 'busy', branchMenuOpen && 'open')}>
                  <GitBranch size={16} />
                  <div className="project-branch-field">
                    <label id="project-source-branch-label">任务源码分支</label>
                    <button
                      type="button"
                      className="project-branch-trigger"
                      aria-labelledby="project-source-branch-label"
                      aria-haspopup="listbox"
                      aria-expanded={branchMenuOpen}
                      disabled={branchControlDisabled}
                      onClick={() => setBranchMenuOpen((open) => !open)}
                    >
                      <span>{activeSourceBranch}{activeSourceBranch === selectedProject.defaultBranch && <em> · 默认</em>}</span>
                      <ChevronDown size={13} />
                    </button>
                    <small>{branchLoading ? '正在读取 GitHub 分支' : branchSwitching ? '正在切换并刷新基线' : `提交 ${selectedProject.headSha.slice(0, 8)}`}</small>
                  </div>
                  {(branchLoading || branchSwitching) && <Loader2 className="spin" size={14} />}
                  {branchMenuOpen && <div className="project-branch-menu" role="listbox" aria-label="任务源码分支">
                    {branchOptions.map((branch) => <button
                      type="button"
                      key={branch.name}
                      role="option"
                      aria-selected={branch.name === activeSourceBranch}
                      className={branch.name === activeSourceBranch ? 'selected' : ''}
                      onClick={() => {
                        setBranchMenuOpen(false);
                        if (branch.name !== activeSourceBranch) void switchProjectBranch(branch.name);
                      }}
                    >
                      <span><strong>{branch.name}</strong>{branch.isDefault && <small>默认分支</small>}</span>
                      {branch.name === activeSourceBranch && <Check size={14} />}
                    </button>)}
                  </div>}
                </div>
                {branchError && <span className="project-branch-error" role="alert"><span>{branchError}</span><button type="button" disabled={branchLoading} onClick={() => setBranchReloadKey((value) => value + 1)}><RefreshCw size={12} />重试</button></span>}
                {projectLocation?.projectId === selectedProject.id ? <><div className="project-sync-location"><CheckCircle2 size={16} /><span><strong>本地仓库已准备</strong><small title={projectLocation.path}>{projectLocation.path}</small></span></div><button className="button secondary" disabled={projectSyncing} onClick={() => void beginProjectSync(selectedProject)}>{projectSyncing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}重新同步</button></> : <button className="button secondary" title="仅在本机执行任务时需要" disabled={projectSyncing || projectLocationChecking} onClick={() => void beginProjectSync(selectedProject)}>{projectSyncing || projectLocationChecking ? <Loader2 className="spin" size={17} /> : <FolderGit2 size={17} />}{projectLocationChecking ? '检查本地仓库' : projectSyncing ? '同步中' : '准备本地仓库'}</button>}
                {taskView === 'market' && <button className="button primary new-task" onClick={() => setCreateOpen(true)}><Plus size={18} />发布任务</button>}
              </div>
            </div>
            {projectSyncNotice && <div className={cn('project-sync-notice', projectSyncNotice.tone)}>{projectSyncNotice.tone === 'success' ? <CheckCircle2 size={17} /> : <XCircle size={17} />}{projectSyncNotice.text}</div>}
            <div className="market-toolbar"><div className="filter-tabs">{viewFilters.map((status) => <button key={status} className={statusFilter === status ? 'active' : ''} onClick={() => setStatusFilter(status)}>{status === 'all' ? '全部' : STATUS[status].label}</button>)}</div><div className="market-count"><UsersRound size={16} />{selectedProjectTasks.length} 个任务</div></div>
            {error && <div className="page-error"><XCircle size={17} />{error}</div>}
            {selectedProjectTasks.length ? <div className="task-grid">{selectedProjectTasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => openTask(task.id)} />)}</div> : <EmptyState icon={<Search />} title="这个项目中没有匹配的任务" description="可以直接发布任务；本地仓库只需在认领并执行任务时准备。" />}
          </>}
        </>}
        {view === 'points' && <><div className="page-head"><div><span className="eyebrow">CONTRIBUTION LEDGER</span><h1>贡献点与账单</h1><p>每一笔分配、冻结和结算都有不可变更的来源记录。</p></div></div><PointsView points={pointsData?.available ?? dashboard.myAvailablePoints} entries={pointsData?.entries ?? []} /></>}
      </div>
    </main>

    <AgentDock
      configured={dashboard.runtime.agentConfigured}
      authorizationRequired={dashboard.runtime.conexusAuthorizationRequired}
      model={dashboard.runtime.agentModel}
      projectId={selectedProject?.id}
      onChanged={() => void load()}
    />

    {createOpen && <CreateTaskModal projects={dashboard.projects} defaultProjectId={selectedProject?.id} onClose={() => setCreateOpen(false)} onCreated={(task) => { setCreateOpen(false); setSelectedProjectId(task.projectId); setSelectedTask(task); void load(); }} />}
    {importOpen && <ImportProjectModal onClose={() => setImportOpen(false)} onImported={(project) => { setImportOpen(false); setSelectedProjectId(project.id); void load(); }} />}
    {collaborationProject && <CollaborationRequestModal project={collaborationProject} githubLogin={dashboard.me.githubLogin} onClose={() => setCollaborationProject(null)} onContinue={() => continuePrivateProjectSync(collaborationProject)} />}
    {selectedTask && <TaskDetail task={selectedTask} me={dashboard.me} projects={dashboard.projects} onClose={() => setSelectedTask(null)} onChanged={(task) => { setSelectedTask(task); void load(); }} onRemoved={(result) => { setSelectedTask(null); setProjectSyncNotice({ tone: 'success', text: result.disposition === 'deleted' ? '任务草稿已永久删除。' : '任务已取消并从任务市场移除。' }); void load(); }} onOpenTask={openTask} />}
  </div>;
}
