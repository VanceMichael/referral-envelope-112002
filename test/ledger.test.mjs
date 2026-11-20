import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLedger,
  applyRecord,
  toMinutes,
  transferred,
  collectibleItems,
  visibleItems,
  pendingStopUse,
  invalidReceipts,
  consultView,
} from '../src/ledger.mjs';

// 合成记录：与演练来源同构
const CASE_KX32 = { consult: 'KX32', alias: '合成来访甲', items: [{ id: 'N6', scope: '通知' }, { id: 'M7', scope: '材料' }] };
const CASE_KX33 = { consult: 'KX33', alias: '合成来访甲', items: [{ id: 'M8', scope: '材料' }] }; // 同别名，不同咨询
const GRANT_GR1 = { consult: 'KX32', grant: 'GR1', point: '站东', purpose: '调解', items: ['M7', 'Y9'], valid: ['09:10', '11:00'] };
const GRANT_GR2 = { consult: 'KX32', grant: 'GR2', point: '站东', purpose: '通知', items: ['N6'], valid: ['09:10', '11:00'] };
const APPT_AP1 = { consult: 'KX32', appointment: 'AP1', point: '站东', purpose: '调解', window: ['10:30', '11:00'] };
const TRANSLATION_Y9 = { consult: 'KX32', id: 'Y9', original: 'M7', language: '本地方言', time: '10:10' };

const AT_1040 = toMinutes('10:40');

function seed() {
  const ledger = createLedger();
  let seq = 0;
  const put = (kind, payload) => applyRecord(ledger, kind, payload, `test/${kind}/${++seq}`);
  put('case', CASE_KX32);
  put('case', CASE_KX33);
  put('appointment', APPT_AP1);
  put('grant', GRANT_GR1);
  put('grant', GRANT_GR2);
  return { ledger, put };
}

test('咨询单分可通知事项与材料条目；同别名不并案，翻译按咨询编号与原件归属', () => {
  const { ledger, put } = seed();
  assert.equal(ledger.consults.size, 2);
  assert.deepEqual([...ledger.consults.get('KX33').items.keys()], ['M8']);

  // 同一咨询的翻译记录：按咨询编号归集，译件 Y9 归属原件 M7
  assert.equal(put('translation', TRANSLATION_Y9).applied, true);
  assert.equal(ledger.consults.get('KX32').translations.get('Y9').original, 'M7');
  assert.equal(ledger.consults.get('KX33').translations.size, 0);

  // 咨询编号不存在时：进入待匹配队列，绝不按姓名相似并到 KX32/KX33
  const late = { consult: 'KX99', id: 'Y8', original: 'M8', language: '手语', time: '09:00' };
  const first = put('translation', late);
  assert.equal(first.retry, true);
  assert.equal(ledger.unmatchedTranslations.length, 1);
  assert.equal(ledger.consults.get('KX32').translations.size, 1);
  assert.equal(ledger.consults.get('KX33').translations.size, 0);

  // 咨询单补到后重试归集
  put('case', { consult: 'KX99', alias: '合成来访甲', items: [{ id: 'M9', scope: '材料' }] });
  assert.equal(put('translation', late).applied, true);
  assert.equal(ledger.unmatchedTranslations.length, 0);
  assert.equal(ledger.consults.get('KX99').translations.get('Y8').original, 'M8');
});

test('预约只证明接手窗口，没有材料授权效力', () => {
  const ledger = createLedger();
  applyRecord(ledger, 'case', CASE_KX32, 't/case/1');
  applyRecord(ledger, 'appointment', APPT_AP1, 't/appt/1');
  // 有预约、无任何授权：不可领、不可见
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', AT_1040), []);
  assert.deepEqual(visibleItems(ledger, '站东', 'KX32', AT_1040), []);
});

test('授权同时限定接收点、用途、材料条目与起止时段，缺一即不可领', () => {
  const { ledger, put } = seed();
  const receipt = (over) => put('received', { sourceReceipt: over.sourceReceipt, grant: 'GR1', item: 'M7', point: '站东', time: '10:24', ...over });

  assert.equal(receipt({ sourceReceipt: 'R-POINT', point: '县北' }).reason, '接收点与授权不符');
  assert.equal(receipt({ sourceReceipt: 'R-TIME', time: '11:05' }).reason, '超出授权时段');
  assert.equal(receipt({ sourceReceipt: 'R-OTHER-CONSULT', item: 'M8' }).reason, '条目不存在'); // M8 属于 KX33，不串号
  assert.equal(receipt({ sourceReceipt: 'R-NOT-IN-GRANT', item: 'N6' }).reason, '条目不在授权范围');
  assert.equal(put('received', { sourceReceipt: 'R-GRANT', grant: 'GX9', item: 'M7', point: '站东', time: '10:24' }).reason, '未知授权');
  assert.equal(put('received', { sourceReceipt: 'R-NOTICE', grant: 'GR2', item: 'N6', point: '站东', time: '10:24' }).reason, '通知事项不可领取');

  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), false);
  assert.equal(invalidReceipts(ledger).length, 6);
  // 全部要素齐备才落账为已交
  assert.equal(receipt({ sourceReceipt: 'R-OK' }).applied, true);
  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), true);
});

test('翻译补到前不可领；补到后也只在其授权范围内可领', () => {
  const { ledger, put } = seed();
  // 翻译记录未到：Y9 虽已列入 GR1，仍不可领
  assert.equal(put('received', { sourceReceipt: 'R-Y-EARLY', grant: 'GR1', item: 'Y9', point: '站东', time: '10:05' }).reason, '条目不存在');
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', AT_1040).map((i) => i.item), ['M7']);

  // 翻译补到（10:10），领取时刻早于到达时刻仍不可领
  put('translation', TRANSLATION_Y9);
  assert.equal(put('received', { sourceReceipt: 'R-Y-BEFORE', grant: 'GR1', item: 'Y9', point: '站东', time: '10:05' }).reason, '翻译未到');

  // 授权范围内、翻译到达之后：可领
  assert.equal(put('received', { sourceReceipt: 'R-Y-OK', grant: 'GR1', item: 'Y9', point: '站东', time: '10:20' }).applied, true);
  assert.equal(transferred(ledger, 'GR1', 'Y9', '站东'), true);
});

test('收窄：未领条目立即不可领，已领条目发停止使用事项并跟踪；其他用途不受影响', () => {
  const { ledger, put } = seed();
  put('translation', TRANSLATION_Y9);
  assert.equal(put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' }).applied, true);

  // 收窄 GR1：保留清单为空，M7 与 Y9 自 10:28 起退出授权范围
  assert.equal(put('restrict', { grant: 'GR1', items: [], time: '10:28' }).applied, true);

  // 尚未领取的 Y9 立即不可领
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', toMinutes('10:35')), []);
  // 已领取的 M7 生成停止使用事项：哪一次授予、哪条资料、哪个接收点
  assert.deepEqual(pendingStopUse(ledger), [{ grant: 'GR1', consult: 'KX32', item: 'M7', point: '站东', since: '10:28' }]);
  // 原接手点其他用途（通知 N6）不受影响
  const visible = visibleItems(ledger, '站东', 'KX32', AT_1040);
  assert.deepEqual(visible.map((i) => i.item), ['N6']);
  assert.equal(visible[0].scope, '通知');

  // 离线包重传同一回执：不重复落账，事项状态不变
  assert.equal(put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' }).duplicate, true);
  assert.equal(pendingStopUse(ledger).length, 1);

  // 逐条确认不能代替停止使用回执；回执条目不符也不闭环
  assert.equal(put('stopped', { sourceReceipt: 'RR6', grant: 'GR1', item: 'Y9', point: '站东', time: '10:40' }).reason, '无待确认的停用事项');
  assert.equal(pendingStopUse(ledger).length, 1);

  // 正确的停止使用回执闭环；且停止使用回执不改变“已交”的历史认定
  assert.equal(put('stopped', { sourceReceipt: 'RR7', grant: 'GR1', item: 'M7', point: '站东', time: '10:40' }).applied, true);
  assert.deepEqual(pendingStopUse(ledger), []);
  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), true);
});

test('改派不迁移收件许可；改派与收窄同轮相遇时目标端越权条目立即不可领', () => {
  const { ledger, put } = seed();
  put('translation', TRANSLATION_Y9);
  put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' });

  // 同一轮离线同步：预约改派 站东 -> 县北，同时 GR1 收窄为空
  assert.equal(put('appointment', { ...APPT_AP1, point: '县北', window: ['10:45', '11:30'] }).reassigned, true);
  assert.equal(put('restrict', { grant: 'GR1', items: [], time: '10:28' }).applied, true);

  // 许可不随预约迁移：县北持有预约但无授权，什么都领不到、看不到
  assert.equal(ledger.grants.get('GR1').point, '站东');
  assert.deepEqual(collectibleItems(ledger, '县北', 'KX32', toMinutes('10:50')), []);
  assert.deepEqual(visibleItems(ledger, '县北', 'KX32', toMinutes('10:50')), []);
  assert.deepEqual(ledger.appointments.get('AP1').history.map((h) => h.point), ['站东']);

  // 站东：已领的 M7 进入停用跟踪，未领的 Y9 不可领，通知用途不受影响
  assert.deepEqual(pendingStopUse(ledger), [{ grant: 'GR1', consult: 'KX32', item: 'M7', point: '站东', since: '10:28' }]);
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', toMinutes('10:50')), []);
  assert.deepEqual(visibleItems(ledger, '站东', 'KX32', toMinutes('10:50')).map((i) => i.item), ['N6']);

  // 另一位合法接手人凭自有授权照常领取自己的部分，且查不到无权得知的条目
  put('grant', { consult: 'KX32', grant: 'GR3', point: '县北', purpose: '调解', items: ['M7'], valid: ['10:30', '11:30'] });
  assert.deepEqual(collectibleItems(ledger, '县北', 'KX32', toMinutes('10:50')).map((i) => i.item), ['M7']);
  assert.deepEqual(visibleItems(ledger, '县北', 'KX32', toMinutes('10:50')).map((i) => i.item), ['M7']);
  assert.equal(put('received', { sourceReceipt: 'RR9', grant: 'GR3', item: 'M7', point: '县北', time: '10:50' }).applied, true);
  assert.equal(transferred(ledger, 'GR3', 'M7', '县北'), true);
});

test('同一条目被拒收时，不能把尚未转交的材料标为已交', () => {
  const { ledger, put } = seed();
  // 先拒收：未转交
  assert.equal(put('denied', { sourceReceipt: 'D1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' }).applied, true);
  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), false);
  // 拒收后出现的领取确认不抵消拒收认定
  put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:25' });
  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), false);
  assert.deepEqual(collectibleItems(ledger, '站东', 'KX32', AT_1040), []); // M7 已拒，Y9 翻译未到
  // 拒收也要在授权范围内
  assert.equal(put('denied', { sourceReceipt: 'D2', grant: 'GR1', item: 'N6', point: '站东', time: '10:24' }).reason, '条目不在授权范围');
});

test('回执晚到：收窄后到达的领取回执按其时点认定，并补发停止使用事项', () => {
  const { ledger, put } = seed();
  put('translation', TRANSLATION_Y9);
  // 收窄先到：M7 尚未领取，无停用事项
  put('restrict', { grant: 'GR1', items: [], time: '10:28' });
  assert.deepEqual(pendingStopUse(ledger), []);
  // 领取回执晚到，但其时点（10:24）在收窄之前：认定已交，并补发停用事项
  assert.equal(put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' }).applied, true);
  assert.equal(transferred(ledger, 'GR1', 'M7', '站东'), true);
  assert.deepEqual(pendingStopUse(ledger), [{ grant: 'GR1', consult: 'KX32', item: 'M7', point: '站东', since: '10:28' }]);
});

test('停止使用回执先于收窄到达：暂记未匹配，收窄后自动闭环', () => {
  const { ledger, put } = seed();
  put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' });
  // 停用回执先到：尚无待确认事项
  assert.equal(put('stopped', { sourceReceipt: 'RR6', grant: 'GR1', item: 'M7', point: '站东', time: '10:40' }).applied, true);
  assert.equal(invalidReceipts(ledger).some((r) => r.receipt === 'RR6' && r.reason === '无待确认的停用事项'), true);
  // 收窄到达后自动闭环
  put('restrict', { grant: 'GR1', items: [], time: '10:28' });
  assert.deepEqual(pendingStopUse(ledger), []);
  assert.equal(ledger.notices.get('GR1|M7|站东').status, 'stopped');
  assert.equal(invalidReceipts(ledger).some((r) => r.receipt === 'RR6'), false);
});

test('办公室台账视图汇总咨询、授权、回执与停用事项', () => {
  const { ledger, put } = seed();
  put('translation', TRANSLATION_Y9);
  put('received', { sourceReceipt: 'RR1', grant: 'GR1', item: 'M7', point: '站东', time: '10:24' });
  put('restrict', { grant: 'GR1', items: [], time: '10:28' });
  const view = consultView(ledger, 'KX32');
  assert.equal(view.alias, '合成来访甲');
  assert.deepEqual(view.items.map((i) => i.id), ['N6', 'M7', 'Y9']);
  assert.deepEqual(view.grants.find((g) => g.id === 'GR1').retained, []);
  assert.deepEqual(view.transfers, [{ grant: 'GR1', item: 'M7', point: '站东' }]);
  assert.equal(view.notices[0].status, 'pending');
  assert.equal(consultView(ledger, 'KX33').items.length, 1); // 同别名咨询互不干扰
});
