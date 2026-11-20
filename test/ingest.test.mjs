import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../source-server.mjs';
import { createLedger, toMinutes, transferred, collectibleItems, visibleItems, pendingStopUse, invalidReceipts } from '../src/ledger.mjs';
import { collectFromSource } from '../src/ingest.mjs';

// 按回放阶段完整走一遍：采集 -> 授权 -> 领取 -> 改派 + 收窄 -> 新点自有授权 -> 停用闭环
test('分阶段采集演练来源，台账状态逐步正确', async (t) => {
  const source = await start();
  t.after(() => new Promise((resolve, reject) => source.server.close((e) => (e ? reject(e) : resolve()))));
  const ledger = createLedger();
  const setStage = async (stage) => {
    const res = await fetch(`${source.url}/control?stage=${stage}`, { method: 'POST' });
    assert.equal(res.status, 200);
  };
  const collect = () => collectFromSource(ledger, source.url);

  // 第 1 阶段：咨询单、预约与授权到达
  await setStage(1);
  let run = await collect();
  assert.deepEqual(run.sources.train, { applied: 2, duplicate: 0, invalid: 0, pending: 0 });
  assert.deepEqual(run.sources.referrals, { applied: 3, duplicate: 0, invalid: 0, pending: 0 });
  assert.equal(ledger.consults.size, 2); // KX32 与 KX33 同别名但不并案
  assert.equal(ledger.grants.size, 2);
  // 翻译 Y9 未到：站东只能领 M7；N6 是通知事项不可领但可见
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', toMinutes('10:40')).map((i) => i.item), ['M7']);
  assert.deepEqual(visibleItems(ledger, '站东', 'KX32', toMinutes('10:40')).map((i) => i.item).sort(), ['M7', 'N6', 'Y9']);
  assert.equal(visibleItems(ledger, '站东', 'KX32', toMinutes('10:40')).find((i) => i.item === 'Y9').reason, '翻译未到');
  // 重复采集同一阶段：全部去重，台账不变
  run = await collect();
  assert.equal(run.sources.train.applied + run.sources.referrals.applied + run.sources.receiver.applied, 0);
  assert.equal(ledger.grants.size, 2);

  // 第 2 阶段：站东领取 M7（回执 RR1）
  await setStage(2);
  run = await collect();
  assert.deepEqual(run.sources.receiver, { applied: 1, duplicate: 0, invalid: 0, pending: 0 });
  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), true);
  assert.equal(invalidReceipts(ledger).length, 0);

  // 第 3 阶段：翻译补到 + 预约改派县北 + GR1 收窄；RR1 随包重传
  await setStage(3);
  run = await collect();
  assert.equal(run.sources.train.applied, 1); // 翻译 Y9
  assert.equal(run.sources.referrals.applied, 2); // 改派 + 收窄
  assert.equal(run.sources.receiver.applied, 0);
  assert.equal(run.sources.receiver.duplicate, 2); // receiver-1 记录级重传 + receiver-2 携带同一回执 RR1
  // 许可不随预约迁移：县北持有预约但无授权
  assert.equal(ledger.appointments.get('AP1').point, '县北');
  assert.deepEqual(collectibleItems(ledger, '县北', 'KX32', toMinutes('10:50')), []);
  // 已领的 M7 进入停用跟踪；未领的 Y9 立即不可领；通知用途不受影响
  assert.deepEqual(pendingStopUse(ledger), [{ grant: 'GR1', consult: 'KX32', item: 'M7', point: '站东', since: '10:28' }]);
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', toMinutes('10:50')), []);
  assert.deepEqual(visibleItems(ledger, '站东', 'KX32', toMinutes('10:50')).map((i) => i.item), ['N6']);

  // 第 4 阶段：县北自有授权 GR3；站东停用回执 RR6 闭环
  await setStage(4);
  run = await collect();
  assert.equal(run.sources.referrals.applied, 1);
  assert.equal(run.sources.receiver.applied, 1);
  assert.deepEqual(pendingStopUse(ledger), []);
  assert.equal(ledger.notices.get('GR1|M7|站东').status, 'stopped');
  // 县北照常领取自己的部分，且看不到站东的条目
  assert.deepEqual(collectibleItems(ledger, '县北', 'KX32', toMinutes('10:50')).map((i) => i.item), ['M7']);
  assert.deepEqual(visibleItems(ledger, '县北', 'KX32', toMinutes('10:50')).map((i) => i.item), ['M7']);
  // 全程无无效回执、无冲突、同别名咨询不受干扰
  assert.equal(invalidReceipts(ledger).length, 0);
  assert.equal(ledger.conflicts.length, 0);
  assert.deepEqual([...ledger.consults.get('KX33').items.keys()], ['M8']);
  assert.equal(ledger.consults.get('KX33').translations.size, 0);

  // 全程幂等：再次采集不产生任何新落账
  run = await collect();
  for (const count of Object.values(run.sources)) {
    assert.equal(count.applied, 0);
    assert.equal(count.invalid, 0);
  }
});
