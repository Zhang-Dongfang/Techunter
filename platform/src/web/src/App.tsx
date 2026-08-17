import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
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
  GitBranch,
  Github,
  Home,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UserRound,
  UsersRound,
  WalletCards,
  X,
  XCircle,
} from 'lucide-react';
import type { DashboardResponse, LedgerEntry, Project, Task, TaskStatus, TaskSummary, User } from '../../shared/contracts';
import { api } from './api';

type View = 'market' | 'mine' | 'review' | 'points';

const STATUS: Record<TaskStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'status-draft' },
  open: { label: '可认领', className: 'status-open' },
  active: { label: '进行中', className: 'status-active' },
  submitted: { label: '待验收', className: 'status-submitted' },
  accepted: { label: '已完成', className: 'status-accepted' },
  cancelled: { label: '已取消', className: 'status-cancelled' },
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

function CreateTaskModal({
  projects,
  parent,
  onClose,
  onCreated,
}: {
  projects: Project[];
  parent?: Task | null;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const [projectId, setProjectId] = useState(parent?.projectId ?? projects[0]?.id ?? '');
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
      <label>原始需求<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说清楚背景、问题和期望结果。Agent 会补全验收标准、文件范围和估价。" minLength={10} rows={7} required /></label>
      <div className="agent-hint"><Sparkles size={18} /><span>创建后，Task Spec Agent 会扫描仓库结构并生成任务说明、Scope 与建议贡献点。</span></div>
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
  onOpenTask,
}: {
  task: Task;
  me: User;
  projects: Project[];
  onClose: () => void;
  onChanged: (task: Task) => void;
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

  return <>
    <Modal onClose={onClose} wide>
      <div className="detail-shell">
        <div className="detail-head">
          <div className="detail-head-main"><div className="detail-meta"><StatusBadge status={task.status} /><span>TH-{shortId(task.id)}</span><span>·</span><span>{task.projectName}</span></div><h2>{task.title}</h2><p>{task.summary || task.description}</p></div>
          <button className="icon-button" onClick={onClose}><X size={21} /></button>
        </div>

        <div className="detail-grid">
          <main className="detail-main">
            <section><div className="section-title"><ShieldCheck size={18} /><h3>验收标准</h3></div>{task.acceptanceCriteria.length ? <ul className="criteria-list">{task.acceptanceCriteria.map((item) => <li key={item}><span><Check size={14} /></span>{item}</li>)}</ul> : <p className="muted">等待 Agent 分析。</p>}</section>

            {task.scope && <section><div className="section-title"><FileCode2 size={18} /><h3>任务文件范围</h3><span className="revision">REV {task.scope.revision}</span></div><div className="scope-columns"><div><h4>可编辑</h4>{task.scope.editablePaths.map((file) => <code key={file}>{file}</code>)}</div><div><h4>只读上下文</h4>{task.scope.readonlyPaths.length ? task.scope.readonlyPaths.map((file) => <code key={file}>{file}</code>) : <span className="muted">无</span>}</div></div><details className="environment-details"><summary>环境与安全策略</summary><dl><dt>镜像</dt><dd>{task.scope.environment.image}</dd><dt>测试</dt><dd>{task.scope.environment.testCommands.join(' · ') || '未配置'}</dd><dt>网络</dt><dd>{task.scope.environment.networkAllowlist.join(' · ') || '默认拒绝'}</dd></dl></details></section>}

            {task.children.length > 0 && <section><div className="section-title"><Layers3 size={18} /><h3>子任务</h3><span className="revision">{task.children.length}</span></div><div className="child-list">{task.children.map((child) => <button key={child.id} onClick={() => onOpenTask(child.id)}><StatusBadge status={child.status} /><span>{child.title}</span><strong>{child.rewardPoints} CP</strong><ArrowRight size={16} /></button>)}</div></section>}

            {task.workspace && <section><div className="section-title"><Command size={18} /><h3>工作环境</h3><span className={cn('workspace-state', task.workspace.status)}>{task.workspace.status}</span></div><div className="workspace-card"><div><span>限定文件工作包</span><code>{task.workspace.packagePath ?? task.workspace.error ?? '准备中'}</code></div>{task.workspace.packagePath && <div className="workspace-actions"><button className="button secondary" onClick={() => setTerminal(true)}><TerminalSquare size={16} />命令台</button>{window.techunterDesktop && <button className="button ghost" onClick={() => window.techunterDesktop?.run({ command: 'code .', cwd: task.workspace?.packagePath ?? undefined })}><Code2 size={16} />VS Code</button>}</div>}</div></section>}

            {submission?.review && <section><div className="review-hero"><div className={cn('score-ring', submission.review.verdict === 'approved' ? 'good' : 'warn')}><strong>{submission.review.score}</strong><span>/100</span></div><div><span className="eyebrow">AI REVIEW</span><h3>{submission.review.verdict === 'approved' ? '自动预审通过' : '需要继续修改'}</h3><p>{submission.review.summary}</p></div></div><div className="finding-list">{submission.review.findings.map((finding) => <div key={finding.criterion}><span className={finding.passed ? 'finding-pass' : 'finding-fail'}>{finding.passed ? <Check size={15} /> : <X size={15} />}</span><div><strong>{finding.criterion}</strong><p>{finding.evidence}</p></div></div>)}</div>{submission.review.risks.length > 0 && <div className="risk-box"><strong>风险提示</strong>{submission.review.risks.map((risk) => <p key={risk}>· {risk}</p>)}</div>}<details className="delivery-doc"><summary>查看 Agent 交付文档</summary><pre>{submission.review.deliveryDocument}</pre></details>{submission.pullRequestUrl && <a className="pr-link" href={submission.pullRequestUrl} target="_blank" rel="noreferrer"><Github size={17} />打开 Pull Request<ExternalLink size={14} /></a>}</section>}
          </main>

          <aside className="detail-side">
            <div className="reward-panel"><span>任务赏金</span><strong>{task.rewardPoints}<em> CP</em></strong><small>验收后自动结算</small></div>
            <dl className="facts"><dt>发布者</dt><dd><Avatar user={task.publisher} small />{task.publisher.name}</dd><dt>执行者</dt><dd>{task.assignee ? <><Avatar user={task.assignee} small />{task.assignee.name}</> : '尚未认领'}</dd><dt>目标分支</dt><dd><code>{task.targetBranch}</code></dd><dt>基础版本</dt><dd><code>{task.baseSha ? task.baseSha.slice(0, 8) : 'working tree'}</code></dd><dt>更新时间</dt><dd>{relativeDate(task.updatedAt)}</dd></dl>
            {task.githubIssueUrl && <a className="github-box" href={task.githubIssueUrl} target="_blank" rel="noreferrer"><Github size={18} /><span><small>GitHub Issue</small>#{task.githubIssueNumber}</span><ExternalLink size={15} /></a>}

            <div className="action-stack">
              {task.status === 'draft' && <><button className="button secondary full" disabled={Boolean(busy)} onClick={() => action('analyze', async () => (await api.analyze(task.id)).task)}>{busy === 'analyze' ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}重新分析</button><label className="reward-input">发布赏金<div><input type="number" min={1} value={reward} onChange={(event) => setReward(Number(event.target.value))} /><span>CP</span></div></label><button className="button primary full" disabled={Boolean(busy)} onClick={() => action('publish', () => api.publish(task.id, reward))}>{busy === 'publish' ? <Loader2 className="spin" size={17} /> : <Activity size={17} />}确认并发布</button></>}
              {task.status === 'open' && <button className="button primary full" disabled={Boolean(busy)} onClick={() => action('claim', () => api.claim(task.id))}>{busy === 'claim' ? <Loader2 className="spin" size={17} /> : <CrosshairIcon />}认领这个任务</button>}
              {task.status === 'active' && mine && <><button className="button primary full" disabled={Boolean(busy)} onClick={() => action('workspace', () => api.workspace(task.id))}>{busy === 'workspace' ? <Loader2 className="spin" size={17} /> : <Command size={17} />}{task.workspace?.status === 'running' ? '重新获取环境' : '创建工作环境'}</button><button className="button secondary full" onClick={() => setSubtask(true)}><GitBranch size={17} />发布子任务</button>{task.workspace?.status === 'running' && <button className="button secondary full" onClick={() => setSubmitOpen((value) => !value)}><CheckCircle2 size={17} />提交交付</button>}<button className="button ghost full" disabled={Boolean(busy)} onClick={() => action('release', () => api.release(task.id))}>释放任务</button></>}
              {task.status === 'submitted' && submission?.status === 'approved' && canReview && <><button className="button primary full" disabled={Boolean(busy)} onClick={() => action('accept', () => api.accept(submission.id))}>{busy === 'accept' ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}验收并结算</button><textarea className="compact-textarea" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} rows={3} /><button className="button danger full" disabled={Boolean(busy)} onClick={() => action('changes', () => api.requestChanges(submission.id, changeReason))}><XCircle size={17} />要求修改</button></>}
              {task.status === 'accepted' && <div className="done-panel"><CheckCircle2 size={22} /><div><strong>任务已完成</strong><span>贡献点已进入执行者账户</span></div></div>}
            </div>
            {error && <div className="form-error"><XCircle size={16} />{error}</div>}
          </aside>
        </div>

        {submitOpen && <div className="inline-form"><div className="section-title"><Bot size={18} /><h3>提交给 Review Agent</h3></div><label>交付摘要<textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} placeholder="完成了什么、有哪些关键决策？" /></label><label>测试输出<textarea value={testOutput} onChange={(event) => setTestOutput(event.target.value)} rows={5} placeholder="粘贴 npm test、typecheck 或其他验证结果。" /></label><div className="form-actions"><button className="button ghost" onClick={() => setSubmitOpen(false)}>取消</button><button className="button primary" disabled={Boolean(busy) || summary.trim().length < 3} onClick={() => action('submit', () => api.submit(task.id, { summary, testOutput }))}>{busy === 'submit' ? <><Loader2 className="spin" size={17} />审查中</> : <><Bot size={17} />提交并自动审查</>}</button></div></div>}
      </div>
    </Modal>
    {subtask && <CreateTaskModal projects={projects} parent={task} onClose={() => setSubtask(false)} onCreated={(created) => { setSubtask(false); onOpenTask(created.id); }} />}
    {terminal && <TerminalPanel cwd={task.workspace?.packagePath ?? ''} onClose={() => setTerminal(false)} />}
  </>;
}

function CrosshairIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2"/></svg>;
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pointsData, setPointsData] = useState<{ available: number; entries: LedgerEntry[] } | null>(null);
  const [demoUsers, setDemoUsers] = useState<User[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api.dashboard();
      setDashboard(data);
      api.demoUsers().then((result) => setDemoUsers(result.users)).catch(() => undefined);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (view === 'points') api.points().then((result) => setPointsData({ available: result.available, entries: result.entries })).catch((caught) => setError((caught as Error).message));
  }, [view, dashboard]);

  async function openTask(id: string) {
    setError('');
    try { setSelectedTask(await api.task(id)); } catch (caught) { setError((caught as Error).message); }
  }

  async function switchUser(login: string) {
    await api.switchDemoUser(login);
    setProfileOpen(false); setSelectedTask(null); await load();
  }

  const tasks = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.tasks.filter((task) => {
      if (view === 'mine' && task.assignee?.id !== dashboard.me.id) return false;
      if (view === 'review' && task.status !== 'submitted') return false;
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      if (search && !`${task.title} ${task.summary} ${task.projectName}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [dashboard, view, statusFilter, search]);

  if (loading && !dashboard) return <div className="boot-screen"><div className="brand-mark"><CrosshairIcon /></div><h1>TECHUNTER</h1><Loader2 className="spin" /></div>;
  if (!dashboard) return <div className="boot-screen error-screen"><XCircle /><h2>无法启动 Techunter</h2><p>{error}</p><button className="button primary" onClick={load}>重试</button></div>;

  const nav = [
    { id: 'market' as const, label: '任务广场', icon: <Home size={19} /> },
    { id: 'mine' as const, label: '我的任务', icon: <UserRound size={19} /> },
    { id: 'review' as const, label: '审核中心', icon: <ShieldCheck size={19} />, count: dashboard.reviewCount },
    { id: 'points' as const, label: '贡献点', icon: <WalletCards size={19} /> },
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="logo"><div className="brand-mark"><CrosshairIcon /></div><div><strong>TECHUNTER</strong><span>科技猎人</span></div></div>
      <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>{item.icon}<span>{item.label}</span>{Boolean(item.count) && <b>{item.count}</b>}</button>)}</nav>
      <div className="sidebar-project"><span className="eyebrow">ACTIVE PROJECT</span><div><span className="project-icon">T</span><div><strong>{dashboard.projects[0]?.name}</strong><small>{dashboard.projects[0]?.repoOwner}/{dashboard.projects[0]?.repoName}</small></div><ChevronDown size={15} /></div></div>
      <div className="sidebar-bottom"><div className="secure-note"><ShieldCheck size={17} /><div><strong>企业内部模式</strong><span>限定文件 · 全程审计</span></div></div><span className="version">v0.1.0 INTERNAL</span></div>
    </aside>

    <main className="content">
      <header className="topbar"><div className="searchbox"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务、项目或猎人..." /><kbd>⌘ K</kbd></div><div className="top-actions"><div className="points-pill"><Coins size={17} /><strong>{dashboard.myAvailablePoints}</strong><span>CP</span></div><button className="refresh-button" onClick={load}><RefreshCw size={17} /></button><div className="profile-wrap"><button className="profile-button" onClick={() => setProfileOpen((value) => !value)}><Avatar user={dashboard.me} /><div><strong>{dashboard.me.name}</strong><span>{dashboard.me.role}</span></div><ChevronDown size={15} /></button>{profileOpen && <div className="profile-menu"><span>演示身份切换</span>{demoUsers.map((user) => <button key={user.id} className={user.id === dashboard.me.id ? 'current' : ''} onClick={() => switchUser(user.login)}><Avatar user={user} small /><div><strong>{user.name}</strong><small>{user.role} · @{user.login}</small></div>{user.id === dashboard.me.id && <Check size={15} />}</button>)}</div>}</div></div></header>

      <div className="page">
        {view !== 'points' && <><div className="page-head"><div><span className="eyebrow">{view === 'market' ? 'TASK MARKET' : view === 'mine' ? 'MY HUNTS' : 'REVIEW QUEUE'}</span><h1>{view === 'market' ? '发现值得解决的问题' : view === 'mine' ? '正在追踪的任务' : '等待验收的交付'}</h1><p>{view === 'market' ? '挑选任务、启动隔离环境，让 Agent 处理繁琐的准备和审查。' : view === 'mine' ? '你的进行中任务、工作环境和交付进度。' : '基于测试证据与 Agent 预审做最终判断。'}</p></div><button className="button primary new-task" onClick={() => setCreateOpen(true)}><Plus size={18} />发布任务</button></div>
          <div className="market-toolbar"><div className="filter-tabs">{['all', 'open', 'active', 'submitted', 'accepted'].map((status) => <button key={status} className={statusFilter === status ? 'active' : ''} onClick={() => setStatusFilter(status)}>{status === 'all' ? '全部' : STATUS[status as TaskStatus].label}</button>)}</div><div className="market-count"><UsersRound size={16} />{tasks.length} 个任务</div></div>
          {error && <div className="page-error"><XCircle size={17} />{error}</div>}
          {tasks.length ? <div className="task-grid">{tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => openTask(task.id)} />)}</div> : <EmptyState icon={<Search />} title="没有匹配的任务" description="调整筛选条件，或者发布一个新任务。" />}
        </>}
        {view === 'points' && <><div className="page-head"><div><span className="eyebrow">CONTRIBUTION LEDGER</span><h1>贡献点与账单</h1><p>每一笔分配、冻结和结算都有不可变更的来源记录。</p></div></div><PointsView points={pointsData?.available ?? dashboard.myAvailablePoints} entries={pointsData?.entries ?? []} /></>}
      </div>
    </main>

    {createOpen && <CreateTaskModal projects={dashboard.projects} onClose={() => setCreateOpen(false)} onCreated={(task) => { setCreateOpen(false); setSelectedTask(task); void load(); }} />}
    {selectedTask && <TaskDetail task={selectedTask} me={dashboard.me} projects={dashboard.projects} onClose={() => setSelectedTask(null)} onChanged={(task) => { setSelectedTask(task); void load(); }} onOpenTask={openTask} />}
  </div>;
}
