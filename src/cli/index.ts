import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { select } from '@inquirer/prompts';
import { createCliSession, destroyCliSession, streamCliInput, listCliUsers } from './api-client.js';

async function main(): Promise<void> {
  const users = await listCliUsers();
  if (users.length === 0) {
    throw new Error('server 中没有可登录用户');
  }

  const username = await select({
    message: '请选择 CLI 登录用户',
    choices: users.map(user => ({
      name: `${user.username} (${user.role})`,
      value: user.username,
    })),
    default: users.find(user => user.username === 'admin')?.username ?? users[0].username,
  });

  let session = await createCliSession(username);

  console.log(`已连接 server，当前用户：${session.user.username} [${session.user.role}]`);
  console.log(`当前 Agent: ${session.agentDisplayName} (${session.agentName})`);
  console.log('输入 /exit 退出\n');

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const line = (await rl.question('samata> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;

      try {
        for await (const event of streamCliInput(session.sessionId, line)) {
          if (event.type === 'text') {
            process.stdout.write(event.chunk);
          } else if (event.type === 'log') {
            console.log(event.line);
          } else if (event.type === 'tool_start') {
            process.stderr.write(`\r\x1b[2m🔧 ${event.name}...\x1b[0m`);
          } else if (event.type === 'thinking') {
            process.stderr.write(`\r\x1b[2m💭 ${event.text.slice(0, 80)}\x1b[0m`);
          } else if (event.type === 'done') {
            session = event.session;
          } else if (event.type === 'error') {
            console.error(event.message);
          }
        }
      } catch (err: any) {
        console.error(err.message ?? String(err));
      }
    }
  } finally {
    await destroyCliSession(session.sessionId).catch(() => {});
    rl.close();
  }
}

main().catch(err => {
  console.error(err.message ?? String(err));
  process.exit(1);
});
