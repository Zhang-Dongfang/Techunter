import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();
try {
  await app.listen({ host: config().host, port: config().port });
  app.log.info(`Techunter API ready at ${config().publicUrl}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
