import { useEffect, useState, type FormEvent } from 'react';
import { FileCode2, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import type { ScopeRequest, ScopeRequestDecision, ScopeRequestInput, Task, User } from '@techunter/core';
import { api } from './api';
import './ScopeRequests.css';

const labels: Record<ScopeRequest['status'], string> = {
  pending: '待审批', approved: '已批准', partially_approved: '部分批准',
  rejected: '已驳回', withdrawn: '已撤回', superseded: '已失效',
};

function ReviewRequest({ request, busy, onDecide }: {
  request: ScopeRequest; busy: boolean; onDecide: (decision: ScopeRequestDecision) => void;
}) {
  const [approvedPaths, setApprovedPaths] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  return <div className="scope-review form-stack">
    <p>逐项选择允许修改的文件。未选中的文件保持原权限；部分批准或驳回时请说明替代做法。</p>
    {request.files.map((file) => <label className="scope-checkbox" key={file.path}>
      <input type="checkbox" checked={approvedPaths.includes(file.path)} disabled={busy} onChange={(event) => setApprovedPaths((current) => event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))} />
      <code>{file.path}</code>
    </label>)}
    <label>审批意见<textarea rows={3} minLength={5} maxLength={5_000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明批准的必要性，或给出驳回原因和可行替代方案（至少 5 字）" /></label>
    <div className="form-actions">
      <button className="button ghost" disabled={busy || reason.trim().length < 5} onClick={() => onDecide({ decision: 'reject', approvedPaths: [], reason })}>驳回申请</button>
      <button className="button primary" disabled={busy || !approvedPaths.length || reason.trim().length < 5} onClick={() => onDecide({ decision: 'approve', approvedPaths, reason })}>批准选中的 {approvedPaths.length} 个文件</button>
    </div>
  </div>;
}

export function ScopeRequests({ task, me, onChanged }: { task: Task; me: User; onChanged: (task: Task) => void }) {
  const [requests, setRequests] = useState<ScopeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [retryOf, setRetryOf] = useState<string>();
  const [files, setFiles] = useState<ScopeRequestInput['files']>([{ path: '', reason: '' }]);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [alternatives, setAlternatives] = useState('');
  const [validationPlan, setValidationPlan] = useState('');
  const mine = task.assignee?.id === me.id;
  const canReview = !mine && (task.publisher.id === me.id || me.role === 'admin');
  const pending = requests.some((request) => request.status === 'pending');
  const canRequest = mine && task.status === 'active' && !pending && !loading;

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    api.scopeRequests(task.id).then((result) => { if (!disposed) setRequests(result.requests); })
      .catch((caught) => { if (!disposed) setError((caught as Error).message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [task.id, task.updatedAt]);

  async function refresh() {
    const [result, latest] = await Promise.all([api.scopeRequests(task.id), api.task(task.id)]);
    setRequests(result.requests);
    onChanged(latest);
  }

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); await refresh(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  function start(previous?: ScopeRequest) {
    setRetryOf(previous?.id);
    setFiles(previous ? previous.files.filter((file) => !previous.approvedPaths.includes(file.path)) : [{ path: '', reason: '' }]);
    setReason(previous?.reason ?? ''); setEvidence('');
    setAlternatives(previous?.alternatives ?? ''); setValidationPlan(previous?.validationPlan ?? '');
    setOpen(true); setNotice('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      await api.requestScope(task.id, { scopeRevision: task.scope!.revision, files, reason, evidence, alternatives, validationPlan, retryOf });
      setOpen(false);
      setNotice('申请已提交。批准前继续按当前文件范围工作；发布者或管理员可在审核中心处理。');
    });
  }

  return <section className="scope-requests">
    <div className="section-title"><FileCode2 size={18} /><h3>修改范围复议</h3><button className="icon-button" aria-label="刷新范围与申请" disabled={busy} onClick={() => void act(async () => undefined)}><RefreshCw size={15} /></button></div>
    <p className="scope-help">遇到范围不足时，申请最少量的具体文件。批准前不会扩大权限；申请不需要模型授权。</p>
    {task.parentTaskId && <p className="scope-help">子任务只能申请父任务已获准修改的文件，超出时请先联系父任务接取者向上申请。</p>}
    {loading && <p className="scope-help"><Loader2 className="spin" size={14} /> 正在加载申请记录</p>}
    {pending && mine && <p className="scope-notice">已有申请等待审批。需要补充材料时，可撤回后重新提交。</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <p className="scope-notice" role="status">{notice}</p>}
    {canRequest && !open && <button className="button secondary" disabled={busy} onClick={() => start()}><Plus size={15} />申请扩大可修改范围</button>}
    {open && mine && task.status === 'active' && !pending && <form className="scope-request-form form-stack" onSubmit={(event) => void submit(event)}>
      <strong>{retryOf ? '补充证据，再次复议' : '扩大修改范围申请'} · 基于 REV {task.scope?.revision}</strong>
      {retryOf && <p className="scope-help">此前意见：{requests.find((request) => request.id === retryOf)?.reviewReason}。请在新证据中逐项回应。</p>}
      {files.map((file, index) => <div className="scope-file-input" key={index}>
        <label>文件 {index + 1} · 仓库相对路径<input value={file.path} required maxLength={500} placeholder="例如 src/auth/session.ts；新文件也须填写完整路径" onChange={(event) => setFiles((current) => current.map((item, i) => i === index ? { ...item, path: event.target.value } : item))} /></label>
        <label>为什么必须修改此文件<textarea rows={2} value={file.reason} required minLength={5} maxLength={2_000} placeholder="关联哪条验收标准，计划做什么改动" onChange={(event) => setFiles((current) => current.map((item, i) => i === index ? { ...item, reason: event.target.value } : item))} /></label>
        {files.length > 1 && <button type="button" className="icon-button" aria-label={`移除文件 ${index + 1}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><X size={15} /></button>}
      </div>)}
      <button type="button" className="button ghost" disabled={files.length >= 20} onClick={() => setFiles((current) => [...current, { path: '', reason: '' }])}><Plus size={14} />添加文件（最多 20 个）</button>
      <label>任务阻塞与申请理由<textarea required rows={3} minLength={10} maxLength={5_000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明当前范围为什么无法完成验收标准（至少 10 字）" /></label>
      <label>{retryOf ? '新增证据与对审批意见的回应' : '证据'}<textarea required rows={3} minLength={10} maxLength={5_000} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="失败测试、错误信息、调用关系或已有只读上下文；请勿粘贴密钥（至少 10 字）" /></label>
      <label>已考虑的替代方案<textarea required rows={2} minLength={10} maxLength={5_000} value={alternatives} onChange={(event) => setAlternatives(event.target.value)} placeholder="为何不能仅修改当前文件，是否能通过接口或拆分任务解决" /></label>
      <label>验证与影响控制<textarea required rows={2} minLength={10} maxLength={5_000} value={validationPlan} onChange={(event) => setValidationPlan(event.target.value)} placeholder="计划运行哪些测试，如何控制影响以及回退修改" /></label>
      <div className="form-actions"><button type="button" className="button ghost" disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="button primary" disabled={busy || loading}>{busy && <Loader2 className="spin" size={14} />}提交申请</button></div>
    </form>}
    <div className="scope-history">{requests.map((request) => <details key={request.id} open={request.status === 'pending'}>
      <summary><span>{labels[request.status]}</span><span>{request.files.length} 个文件 · REV {request.scopeRevision}{request.resultingRevision ? ` → ${request.resultingRevision}` : ''}</span><small>{new Date(request.createdAt).toLocaleString('zh-CN')}</small></summary>
      <div className="scope-history-body">
        <p className="scope-help">申请人 {request.requesterId === me.id ? '我' : task.assignee?.id === request.requesterId ? task.assignee.name : request.requesterId.slice(0, 8)}{request.retryOf ? ` · 复议自 ${request.retryOf.slice(0, 8)}` : ''}</p>
        {request.files.map((file) => <div className="scope-history-file" key={file.path}><code>{file.path}</code>{request.approvedPaths.includes(file.path) && <span>已授权</span>}<p>{file.reason}</p></div>)}
        <dl><dt>申请理由</dt><dd>{request.reason}</dd><dt>证据</dt><dd>{request.evidence}</dd><dt>替代方案</dt><dd>{request.alternatives}</dd><dt>验证计划</dt><dd>{request.validationPlan}</dd></dl>
        {request.reviewReason && <p className="scope-notice">审批 / 处理意见：{request.reviewReason}{request.resolvedAt && `（${new Date(request.resolvedAt).toLocaleString('zh-CN')}）`}</p>}
        {request.status === 'pending' && request.requesterId === me.id && <button className="button ghost" disabled={busy} onClick={() => void act(async () => { await api.withdrawScope(task.id, request.id); })}>撤回申请</button>}
        {request.status === 'pending' && canReview && task.status === 'active' && <ReviewRequest request={request} busy={busy} onDecide={(decision) => void act(async () => {
          const result = await api.decideScope(task.id, request.id, decision);
          setNotice(result.githubSynced === false ? '批准已生效，但 GitHub 文件范围同步失败。可使用下方按钮重试同步。' : result.githubSynced ? '批准已生效，GitHub 文件范围已同步。' : '申请已驳回，原文件范围保持有效。');
        })} />}
        {canRequest && request.requesterId === me.id && ['rejected', 'partially_approved'].includes(request.status) && !requests.some((next) => next.retryOf === request.id && !['withdrawn', 'superseded'].includes(next.status)) && <button className="button secondary" disabled={busy} onClick={() => start(request)}>补充证据再复议</button>}
      </div>
    </details>)}</div>
    {canReview && task.scope && task.scope.revision > 1 && <button className="button ghost" disabled={busy} onClick={() => void act(async () => { await api.syncScope(task.id); setNotice('当前文件范围已同步到 GitHub。'); })}><RefreshCw size={14} />同步当前范围到 GitHub</button>}
  </section>;
}
