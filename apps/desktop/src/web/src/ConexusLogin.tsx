import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Loader2, LogIn, ShieldCheck, XCircle } from 'lucide-react';

import type { ConexusAccountAuthorization, ConexusAuthConfig } from '@techunter/core';
import { api } from './api';

export function ConexusLogin({ onAuthorized }: { onAuthorized: () => void }) {
  const [config, setConfig] = useState<ConexusAuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const popupMonitor = useRef<number | null>(null);

  useEffect(() => {
    api.conexusConfig().then(setConfig).catch((caught) => setError((caught as Error).message));
    return () => {
      if (popupMonitor.current !== null) window.clearInterval(popupMonitor.current);
    };
  }, []);

  const receiveAuthorization = useCallback(async (event: MessageEvent) => {
    if (!config || event.origin !== new URL(config.apiUrl).origin) return;
    if (!event.data || typeof event.data !== 'object') return;
    const message = event.data as { source?: unknown; authorization?: unknown };
    if (message.source !== 'conexus.web-auth.v1' || !message.authorization || typeof message.authorization !== 'object') return;
    const authorization = message.authorization as ConexusAccountAuthorization;
    if (!authorization.runTicket?.startsWith('cnx_run_v1.') || !authorization.expiresAt || !authorization.user?.id) return;
    setBusy(true);
    setError('');
    try {
      await api.authorizeConexus(authorization, window.location.origin);
      onAuthorized();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [config, onAuthorized]);

  useEffect(() => {
    window.addEventListener('message', receiveAuthorization);
    return () => window.removeEventListener('message', receiveAuthorization);
  }, [receiveAuthorization]);

  function signIn() {
    if (!config || busy) return;
    setBusy(true);
    setError('');
    const url = new URL('/v1/auth/web', config.apiUrl);
    url.searchParams.set('audience', window.location.origin);
    url.searchParams.set('publicationSlug', config.publicationSlug);
    url.searchParams.set('displayName', config.displayName);
    const popup = window.open(url.toString(), 'conexus-account', 'popup,width=480,height=720');
    if (!popup) {
      setBusy(false);
      setError('请允许 Conexus 登录弹窗后重试。');
      return;
    }
    popupMonitor.current = window.setInterval(() => {
      if (!popup.closed) return;
      if (popupMonitor.current !== null) window.clearInterval(popupMonitor.current);
      popupMonitor.current = null;
      setBusy(false);
    }, 500);
  }

  return <main className="conexus-login-shell">
    <section className="conexus-login-card">
      <div className="conexus-login-brand"><span><Crosshair size={22} /></span><strong>TECHUNTER</strong></div>
      <div className="conexus-login-icon"><ShieldCheck size={25} /></div>
      <span className="eyebrow">CONEXUS ACCOUNT</span>
      <h1>登录科技猎人</h1>
      <p>使用 Conexus 企业账号进入。模型额度、请求日志和 Token 用量将归属当前用户。</p>
      <button className="button primary conexus-login-button" onClick={signIn} disabled={!config || busy}>
        {busy ? <><Loader2 className="spin" size={17} />等待 Conexus</> : <><LogIn size={17} />登录或注册</>}
      </button>
      {error && <div className="form-error"><XCircle size={16} />{error}</div>}
      <small>密码只提交给 Conexus 官方账号服务；Techunter 仅保存短期、限定作用域的 Run Ticket。</small>
    </section>
  </main>;
}
