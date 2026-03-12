import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  );
}

// For OpenAI SDK (uses Node.js http/https module)
export function getHttpsProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxy = getProxyUrl();
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

// For Octokit (uses native fetch with undici dispatcher)
export function getUndiciProxyAgent(): ProxyAgent | undefined {
  const proxy = getProxyUrl();
  return proxy ? new ProxyAgent(proxy) : undefined;
}
