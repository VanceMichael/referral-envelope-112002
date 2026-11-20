// 办公室台账服务：采集来源记录，提供办公室与接收点两类查询。
// 接收点视图只暴露其有效授权范围内的条目；范围外的条目内容不可得知。

import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  createLedger,
  toMinutes,
  consultView,
  collectibleItems,
  visibleItems,
  pendingStopUse,
  invalidReceipts,
  summary,
} from './ledger.mjs';
import { collectFromSource } from './ingest.mjs';

const DEFAULT_DAY_END = toMinutes('23:59');

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  if (!text) return {};
  return JSON.parse(text);
}

function parseAt(url) {
  const raw = url.searchParams.get('at');
  if (raw === null) return { atMin: DEFAULT_DAY_END };
  const atMin = toMinutes(raw);
  return Number.isInteger(atMin) ? { atMin } : { error: 'at 参数无效' };
}

export async function startOffice({ port = 0, host = '127.0.0.1', sourceUrl = null, ledger = createLedger() } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (request.method === 'POST' && path === '/ingest') {
        const body = await readBody(request);
        const target = body.sourceUrl ?? sourceUrl;
        if (!target) {
          sendJson(response, 400, { error: '未配置来源地址' });
          return;
        }
        sendJson(response, 200, await collectFromSource(ledger, target, body));
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '仅支持读取与采集' });
        return;
      }
      if (path === '/') {
        sendJson(response, 200, {
          service: 'referral-office',
          source: sourceUrl,
          routes: [
            'POST /ingest',
            'GET /office/summary',
            'GET /office/pending-stop-use',
            'GET /office/invalid-receipts',
            'GET /office/unmatched-translations',
            'GET /office/consults/:consult',
            'GET /office/appointments/:appointment',
            'GET /points/:point/consults/:consult/items?at=HH:MM',
            'GET /points/:point/collectible?consult=..&at=HH:MM',
          ],
        });
        return;
      }
      if (path === '/office/summary') {
        sendJson(response, 200, summary(ledger));
        return;
      }
      if (path === '/office/pending-stop-use') {
        sendJson(response, 200, { pending: pendingStopUse(ledger) });
        return;
      }
      if (path === '/office/invalid-receipts') {
        sendJson(response, 200, { invalid: invalidReceipts(ledger), conflicts: ledger.conflicts });
        return;
      }
      if (path === '/office/unmatched-translations') {
        sendJson(response, 200, { unmatched: ledger.unmatchedTranslations });
        return;
      }
      let match = /^\/office\/consults\/([^/]+)$/.exec(path);
      if (match) {
        const view = consultView(ledger, decodeURIComponent(match[1]));
        if (!view) {
          sendJson(response, 404, { error: '未知咨询编号' });
          return;
        }
        sendJson(response, 200, view);
        return;
      }
      match = /^\/office\/appointments\/([^/]+)$/.exec(path);
      if (match) {
        const appointment = ledger.appointments.get(decodeURIComponent(match[1]));
        if (!appointment) {
          sendJson(response, 404, { error: '未知预约' });
          return;
        }
        sendJson(response, 200, appointment);
        return;
      }
      match = /^\/points\/([^/]+)\/consults\/([^/]+)\/items$/.exec(path);
      if (match) {
        const { atMin, error } = parseAt(url);
        if (error) {
          sendJson(response, 400, { error });
          return;
        }
        const items = visibleItems(ledger, decodeURIComponent(match[1]), decodeURIComponent(match[2]), atMin);
        if (items === null) {
          sendJson(response, 404, { error: '未知咨询编号' });
          return;
        }
        sendJson(response, 200, { items });
        return;
      }
      match = /^\/points\/([^/]+)\/collectible$/.exec(path);
      if (match) {
        const consultNo = url.searchParams.get('consult');
        const { atMin, error } = parseAt(url);
        if (!consultNo) {
          sendJson(response, 400, { error: '缺少 consult 参数' });
          return;
        }
        if (error) {
          sendJson(response, 400, { error });
          return;
        }
        const items = collectibleItems(ledger, decodeURIComponent(match[1]), consultNo, atMin);
        if (items === null) {
          sendJson(response, 404, { error: '未知咨询编号' });
          return;
        }
        sendJson(response, 200, { items });
        return;
      }
      sendJson(response, 404, { error: '未找到路由' });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: '台账处理失败' });
      else response.destroy();
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  return { server, ledger, url: `http://${host}:${server.address().port}` };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = await startOffice({
    port: Number(process.env.PORT ?? 4200),
    sourceUrl: process.env.SOURCE_URL ?? 'http://127.0.0.1:4100',
  });
  console.log(`办公室台账 ${app.url}，来源 ${process.env.SOURCE_URL ?? 'http://127.0.0.1:4100'}`);
}
