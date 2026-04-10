import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { select } from '@inquirer/prompts';
import { createCliSession, destroyCliSession, streamCliInput, sendPromptReply, listCliUsers, isConnectionError, waitForServer } from './api-client.js';

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

  async function reconnect(): Promise<void> {
    console.log('\n\x1b[33m⚠ 与 server 的连接已断开，正在重连...\x1b[0m');
    await waitForServer();
    session = await createCliSession(username);
    console.log(`\r\x1b[32m✔ 已重新连接 server (${session.agentDisplayName})\x1b[0m\n`);
  }

  async function handleStream(line: string): Promise<void> {
    for await (const event of streamCliInput(session.sessionId, line)) {
      if (event.type === 'text') {
        process.stdout.write(event.chunk);
      } else if (event.type === 'log') {
        console.log(event.line);
      } else if (event.type === 'prompt') {
        const answer = await rl.question(`${event.message} `);
        await sendPromptReply(session.sessionId, event.promptId, answer);
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
  }

  try {
    while (true) {
      const line = (await rl.question('samata> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;

      try {
        await handleStream(line);
      } catch (err: any) {
        if (isConnectionError(err)) {
          try {
            await reconnect();
            await handleStream(line);
          } catch (retryErr: any) {
            console.error(retryErr.message ?? String(retryErr));
          }
        } else {
          console.error(err.message ?? String(err));
        }
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
