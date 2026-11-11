import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRouter);

const port = Number(process.env.PORT ?? 4000);

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`[pointwise-server] listening on http://localhost:${port}`);
  });
}

export { app };
