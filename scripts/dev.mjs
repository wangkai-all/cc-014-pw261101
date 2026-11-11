// 一键拉起本地闭环：Express 接收端（:4000）+ Vite 演示页（:5173）
import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }),
];

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
