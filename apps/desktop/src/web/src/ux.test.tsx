// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { AgentDock } from './AgentDock';
import { ConexusLogin } from './ConexusLogin';
import { Modal } from './Modal';
import { api } from './api';

vi.mock('./api', () => ({ api: { chat: vi.fn(), conexusConfig: vi.fn() } }));
const props = { configured: true, model: 'fixture', userId: 'user', projectId: 'project-a', onOpenTask: vi.fn(), onChanged: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it('does not send when Enter confirms Chinese composition', async () => {
  render(<AgentDock {...props} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '中文任务' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(api.chat).not.toHaveBeenCalled();
  vi.mocked(api.chat).mockResolvedValue({ reply: '完成', activities: [] });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
  await screen.findByText('完成');
  expect(api.chat).toHaveBeenCalledOnce();
});

it('cancels a pending conversation and permits another message', async () => {
  vi.mocked(api.chat).mockImplementation((_body, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason));
  }));
  render(<AgentDock {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '查询任务' } });
  fireEvent.click(screen.getByTitle('发送'));
  await waitFor(() => expect(api.chat).toHaveBeenCalledOnce());
  expect((screen.getByTitle('清空对话') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  await screen.findByText(/已停止等待/);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  expect(vi.mocked(api.chat).mock.calls[0]![1]!.aborted).toBe(true);
});

it('does not carry a conversation into a different project', async () => {
  vi.mocked(api.chat).mockResolvedValue({ reply: '项目 A 的内容', activities: [] });
  const page = render(<AgentDock {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '查看代码' } });
  fireEvent.click(screen.getByTitle('发送'));
  await screen.findByText('项目 A 的内容');
  page.rerender(<AgentDock {...props} projectId="project-b" />);
  expect(screen.queryByText('项目 A 的内容')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新的查询' } });
  fireEvent.click(screen.getByTitle('发送'));
  await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.chat).mock.calls[1]![0]).toMatchObject({ projectId: 'project-b', history: [] });
  await act(async () => {});
});

it('recovers login configuration without restarting the app', async () => {
  vi.mocked(api.conexusConfig).mockRejectedValueOnce(new Error('暂时无法连接'));
  render(<ConexusLogin onAuthorized={vi.fn()} />);
  await screen.findByText('暂时无法连接');
  vi.mocked(api.conexusConfig).mockResolvedValue({} as Awaited<ReturnType<typeof api.conexusConfig>>);
  fireEvent.click(screen.getByRole('button', { name: '重新连接登录服务' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '使用浏览器登录' }) as HTMLButtonElement).disabled).toBe(false));
});

it('Escape closes only the top dialog and restores parent focus', () => {
  const parentClose = vi.fn();
  function Dialogs() {
    const [nested, setNested] = useState(false);
    return <Modal onClose={parentClose}><button onClick={() => setNested(true)}>打开子窗口</button>
      {nested && <Modal onClose={() => setNested(false)}><button>子窗口按钮</button></Modal>}
    </Modal>;
  }
  render(<Dialogs />);
  fireEvent.click(screen.getByText('打开子窗口'));
  expect(document.activeElement).toBe(screen.getByText('子窗口按钮'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByText('子窗口按钮')).toBeNull();
  expect(parentClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByText('打开子窗口'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(parentClose).toHaveBeenCalledOnce();
});

it('keeps keyboard focus within the modal and restores the opener', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const page = render(<Modal onClose={vi.fn()}><button>第一个</button><button>最后一个</button></Modal>);
  expect(document.body.style.overflow).toBe('hidden');
  screen.getByText('最后一个').focus();
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByText('第一个'));
  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText('最后一个'));
  page.unmount();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
  opener.remove();
});
