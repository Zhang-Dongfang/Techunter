import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Bot, ChevronDown, ChevronUp, Loader2, Send, Sparkles, Trash2, XCircle } from 'lucide-react';

import type { AgentActivity, AgentChatMessage } from '@techunter/core';
import { api } from './api';

interface DisplayMessage extends AgentChatMessage {
  id: string;
  activities?: AgentActivity[];
  error?: boolean;
}

const suggestions = ['有哪些任务可以认领？', '查看我的进行中任务', '分析一下当前仓库结构'];

function activityLabel(name: string): string {
  return ({
    list_tasks: '读取任务列表',
    get_task: '读取任务详情',
    create_task: '创建任务草稿',
    claim_task: '认领任务',
    create_workspace: '部署工作环境',
    list_files: '扫描仓库文件',
    grep_code: '检索代码',
    run_command: '执行本机命令',
  } as Record<string, string>)[name] ?? name;
}

export function AgentDock({
  configured,
  model,
  projectId,
  onChanged,
}: {
  configured: boolean;
  model: string | null;
  projectId?: string;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sequence = useRef(0);

  function nextId(): string {
    sequence.current += 1;
    return String(sequence.current);
  }

  async function send(message = input) {
    const text = message.trim();
    if (!configured || busy || !text) return;
    const history = messages.filter((item) => !item.error).map(({ role, content }) => ({ role, content }));
    const userMessage: DisplayMessage = { id: nextId(), role: 'user', content: text };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setExpanded(true);
    setBusy(true);
    try {
      const identity = await window.techunterDesktop?.identity();
      const result = await api.chat({ message: text, history, projectId, ...identity });
      setMessages((current) => [...current, {
        id: nextId(),
        role: 'assistant',
        content: result.reply,
        activities: result.activities,
      }]);
      onChanged();
    } catch (caught) {
      setMessages((current) => [...current, {
        id: nextId(),
        role: 'assistant',
        content: (caught as Error).message,
        error: true,
      }]);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return <section className={`agent-dock${expanded ? ' expanded' : ''}`}>
    {expanded && <div className="agent-thread">
      <div className="agent-thread-head">
        <div><span className="agent-avatar"><Bot size={17} /></span><div><strong>Techunter Agent</strong><small>{model ?? '未配置模型'}</small></div></div>
        <div><button title="清空对话" onClick={() => setMessages([])}><Trash2 size={15} /></button><button title="收起" onClick={() => setExpanded(false)}><ChevronDown size={17} /></button></div>
      </div>
      <div className="agent-messages">
        {messages.length === 0 && <div className="agent-welcome"><Sparkles size={20} /><strong>和 CLI 使用同一个 Agent Core</strong><span>可以查询任务、创建任务草稿、认领工作、扫描代码或执行仓库命令。</span><div>{suggestions.map((suggestion) => <button key={suggestion} onClick={() => void send(suggestion)}>{suggestion}</button>)}</div></div>}
        {messages.map((message) => <div key={message.id} className={`agent-message ${message.role}${message.error ? ' error' : ''}`}>
          <span>{message.role === 'assistant' ? <Bot size={15} /> : '你'}</span>
          <div>
            {message.activities && message.activities.length > 0 && <div className="agent-activities">{message.activities.map((activity, index) => <details key={`${activity.name}-${index}`}><summary><i />{activityLabel(activity.name)}</summary>{activity.result && <pre>{activity.result}</pre>}</details>)}</div>}
            <p>{message.content}</p>
          </div>
        </div>)}
        {busy && <div className="agent-message assistant thinking"><span><Bot size={15} /></span><div><p><Loader2 className="spin" size={14} />Agent 正在思考并调用工具…</p></div></div>}
      </div>
    </div>}

    <form className="agent-composer" onSubmit={submit}>
      <button type="button" className="agent-orb" onClick={() => setExpanded((value) => !value)} title={expanded ? '收起对话' : '展开对话'}><Bot size={20} />{!expanded && messages.length > 0 && <i />}</button>
      <div><textarea rows={1} value={input} onFocus={() => setExpanded(true)} onChange={(event) => setInput(event.target.value)} onKeyDown={keyDown} disabled={!configured || busy} placeholder={configured ? '交给 Agent：查询任务、发布工作、分析代码…' : 'Agent 未配置，请先运行 tch init'} /><span>Enter 发送 · Shift Enter 换行</span></div>
      <button className="agent-send" disabled={!configured || busy || !input.trim()} title="发送">{busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}</button>
      {!expanded && <button type="button" className="agent-expand" onClick={() => setExpanded(true)} title="展开对话"><ChevronUp size={17} /></button>}
      {!configured && <span className="agent-config-error"><XCircle size={14} />未连接</span>}
    </form>
  </section>;
}
