const endpoints = [
  'http://127.0.0.1:5173/',
  'http://127.0.0.1:4310/health',
];

const deadline = Date.now() + 30_000;
let lastError = '';
let ready = false;

process.stdout.write('[desktop] 等待 Web 与 API 就绪');
while (Date.now() < deadline) {
  try {
    const responses = await Promise.all(endpoints.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(1_500) })
    ));
    await Promise.all(responses.map((response) => response.body?.cancel()));
    if (responses.every((response) => response.ok)) {
      process.stdout.write('\n[desktop] Web 与 API 已就绪，正在启动 Electron…\n');
      ready = true;
      break;
    }
    lastError = responses.map((response) => `${response.url}: ${response.status}`).join(', ');
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
