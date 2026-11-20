import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../source-server.mjs';
import { startOffice } from '../src/office-server.mjs';

const close = (server) => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

test('办公室台账服务：分阶段采集、办公室视图与接收点视图', async (t) => {
  const source = await start();
  const office = await startOffice({ sourceUrl: source.url });
  t.after(async () => { await close(office.server); await close(source.server); });

  const get = async (path) => {
    const res = await fetch(`${office.url}${path}`);
    return { status: res.status, body: await res.json() };
  };
  const ingest = async () => {
    const res = await fetch(`${office.url}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    return res.json();
  };
  const setStage = async (stage) => {
    const res = await fetch(`${source.url}/control?stage=${stage}`, { method: 'POST' });
    assert.equal(res.status, 200);
  };

  // 第 1-2 阶段：采集后无待停用事项；站东可见授权内条目
  await setStage(1);
  await ingest();
  await setStage(2);
  await ingest();
  let view = await get('/office/pending-stop-use');
  assert.deepEqual(view.body.pending, []);
  view = await get('/points/站东/consults/KX32/items?at=10:40');
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.items.map((i) => i.item).sort(), ['M7', 'N6', 'Y9']);
  assert.equal(view.body.items.find((i) => i.item === 'Y9').available, false); // 翻译未到
  assert.equal(view.body.items.find((i) => i.item === 'M7').transferred, true);

  // 第 3 阶段：改派 + 收窄；办公室看到待停用事项（授予、资料、接收点）
  await setStage(3);
  await ingest();
  view = await get('/office/pending-stop-use');
  assert.deepEqual(view.body.pending, [{ grant: 'GR1', consult: 'KX32', item: 'M7', point: '站东', since: '10:28' }]);
  // 县北持预约但无授权：看不到任何条目
  view = await get('/points/县北/consults/KX32/items?at=10:50');
  assert.deepEqual(view.body.items, []);
  view = await get('/points/县北/collectible?consult=KX32&at=10:50');
  assert.deepEqual(view.body.items, []);
  // 预约轨迹可查：接手窗口从站东改派到县北
  view = await get('/office/appointments/AP1');
  assert.equal(view.body.point, '县北');
  assert.equal(view.body.history[0].point, '站东');

  // 第 4 阶段：县北自有授权后可领；站东停用闭环
  await setStage(4);
  const last = await ingest();
  assert.equal(last.ledger.notices.pending, 0);
  view = await get('/points/县北/collectible?consult=KX32&at=10:50');
  assert.deepEqual(view.body.items.map((i) => i.item), ['M7']);
  view = await get('/points/县北/consults/KX32/items?at=10:50');
  assert.deepEqual(view.body.items.map((i) => i.item), ['M7']); // 查不到站东的 N6/Y9
  view = await get('/office/pending-stop-use');
  assert.deepEqual(view.body.pending, []);

  // 办公室台账总览与单咨询视图
  view = await get('/office/summary');
  assert.deepEqual(view.body.receipts, { total: 2, valid: 2, invalid: 0 });
  view = await get('/office/consults/KX32');
  assert.deepEqual(view.body.items.map((i) => i.id), ['N6', 'M7', 'Y9']);
  assert.deepEqual(view.body.transfers, [{ grant: 'GR1', item: 'M7', point: '站东' }]);
  assert.equal(view.body.notices[0].status, 'stopped');
  view = await get('/office/consults/KX33');
  assert.deepEqual(view.body.items.map((i) => i.id), ['M8']); // 同别名不并案

  // 异常路径
  assert.equal((await get('/office/consults/KX99')).status, 404);
  assert.equal((await get('/points/县北/consults/KX99/items')).status, 404);
  assert.equal((await get('/points/县北/collectible?at=10:50')).status, 400);
  assert.equal((await get('/points/县北/collectible?consult=KX32&at=25:00')).status, 400);
  assert.equal((await get('/office/invalid-receipts')).body.invalid.length, 0);
});
