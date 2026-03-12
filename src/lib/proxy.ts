import { ProxyAgent, setGlobalDispatcher } from 'undici';

export function setupProxy(): void {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;

  if (proxy) {
    setGlobalDispatcher(new ProxyAgent(proxy));
  }
}
