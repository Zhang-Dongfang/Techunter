const endpoint = 'http://127.0.0.1:5173/';

const deadline = Date.now() + 30_000;
let lastError = '';
let ready = false;

process.stdout.write('[desktop] 等待本地 UI 就绪');
while (Date.now() < deadline) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    await response.body?.cancel();
    if (response.ok) {
      process.stdout.write('\n[desktop] 本地 UI 已就绪，正在启动 Electron…\n');
      ready = true;
      break;
    }
    lastError = `${response.url}: ${response.status}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  process.stdout.write('.');
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (!ready) {
  process.stdout.write('\n');
  console.error(`[desktop] 等待开发服务超时：${lastError}`);
  process.exitCode = 1;
}
