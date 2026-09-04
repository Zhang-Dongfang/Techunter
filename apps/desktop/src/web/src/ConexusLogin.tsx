import { useEffect, useState } from 'react';
import { Crosshair, Loader2, LogIn, ShieldCheck, XCircle } from 'lucide-react';

import type { ConexusAuthConfig } from '@techunter/core';
import { api } from './api';

export function ConexusLogin({ onAuthorized }: { onAuthorized: () => void }) {
  const [config, setConfig] = useState<ConexusAuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.conexusConfig().then(setConfig).catch((caught) => setError((caught as Error).message));
  }, []);

  async function signIn() {
    if (!config || busy) return;
    if (!window.techunterDesktop) {
      setError('请在 Techunter Desktop 中使用系统浏览器登录。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const authorization = await window.techunterDesktop.authorizeConexus(config);
      await api.authorizeConexus(authorization, window.location.origin);
      onAuthorized();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="conexus-login-shell">
    <section className="conexus-login-card">
      <div className="conexus-login-brand"><span><Crosshair size={22} /></span><strong>TECHUNTER</strong></div>
      <div className="conexus-login-icon"><ShieldCheck size={25} /></div>
      <span className="eyebrow">CONEXUS ACCOUNT</span>
      <h1>登录科技猎人</h1>
      <p>使用 Conexus 企业账号进入。模型额度、请求日志和 Token 用量将归属当前用户。</p>
      <button className="button primary conexus-login-button" onClick={signIn} disabled={!config || busy}>
        {busy ? <><Loader2 className="spin" size={17} />等待浏览器授权</> : <><LogIn size={17} />使用浏览器登录</>}
      </button>
      {error && <div className="form-error"><XCircle size={16} />{error}</div>}
      <small>系统浏览器会复用已保存的 Conexus 会话；Techunter 仅接收短期、限定作用域的 Run Ticket。</small>
    </section>
  </main>;
}
