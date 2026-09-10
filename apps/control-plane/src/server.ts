import { buildApp } from './app.js';

// Plan 01-03 Task 2 replaces this literal with the Zod-validated `env.PORT` and adds the
// `import './env.js'` fail-fast side effect as the very first import in this file.
const PORT = 3000;

const app = buildApp();

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
