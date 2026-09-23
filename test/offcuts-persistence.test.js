'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const oc = require('../src/offcuts');

const {
  initOffcutStore,
  useEphemeralStore,
  SnapshotIOError,
  SnapshotCorruptError,
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
} = oc;

/** 每个测试使用独立临时快照文件，互不干扰 */
function tempSnapshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcuts-snap-'));
  return { dir, file: path.join(dir, 'snapshot.json') };
}

/**
 * 构造“读时不存在（按空库启动）、写时必失败”的快照路径：
 * 中间目录是普通文件，readFileSync 返回 ENOENT 被当作空库，
 * 而 mkdirSync 沿路径建目录时必报 ENOTDIR（root 下同样稳定）。
 */
function unwritableSnapshotUnder(dir) {
  fs.writeFileSync(path.join(dir, 'blocker'), 'x', 'utf8');
  return path.join(dir, 'blocker', 'deep', 'snapshot.json');
}

/* ---------------- 纯内存模式基线 ---------------- */

test('未初始化（纯内存模式）下写操作不接触磁盘，行为与原内存库存一致', () => {
  useEphemeralStore();
  const { offcut } = createOffcut({ width: 100, height: 80, batchId: 'MEM' });
  assert.equal(offcut.id, 'OC-000001');
  assert.equal(listOffcuts().summary.total, 1);
});

/* ---------------- 启动恢复 ---------------- */

test('快照文件不存在时按空库启动，并在首次写入时创建快照', () => {
  const { dir, file } = tempSnapshot();
  assert.ok(!fs.existsSync(file));
  initOffcutStore(file);
  assert.equal(listOffcuts().summary.total, 0);

  createOffcut({ width: 100, height: 80, batchId: 'B1' });
  assert.ok(fs.existsSync(file), '首次写入应生成快照文件');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.seq, 1);
  assert.equal(saved.offcuts.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('重启恢复：余料记录、预占关系与三个自动编号全部还原', () => {
  const { dir, file } = tempSnapshot();
  initOffcutStore(file);

  // 手工录入 2 块 + 结果登记 1 块（消耗余料/批次序号）
  createOffcut({ paperName: '大块', width: 300, height: 300 });
  createOffcut({ paperName: '中块', width: 200, height: 200 });
  const layoutResult = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 50, h: 40 }],
  };
  ingestOffcuts({ layout: layoutResult, batchId: 'B-RESTORE' });
  const a1 = allocateOffcuts({ width: 100, height: 100, quantity: 1, ref: 'WO-1' });
  assert.equal(a1.status, 'fulfilled');
  assert.equal(a1.allocationId, 'AL-000001');

  // —— 模拟服务重启：重新从同一快照恢复 ——
  initOffcutStore(file);

  const list = listOffcuts();
  assert.equal(list.summary.total, 3);
  assert.equal(list.summary.available, 2);
  assert.equal(list.summary.reserved, 1);

  const reserved = listOffcuts({ status: 'reserved' }).offcuts;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].reservation.allocationId, 'AL-000001');
  assert.equal(reserved[0].reservation.ref, 'WO-1');
  assert.equal(reserved[0].reservation.product.width, 100);
  assert.equal(reserved[0].status, 'reserved');

  // 三个编号不回退、不重复
  const next = createOffcut({ width: 10, height: 10 });
  assert.equal(next.offcut.id, 'OC-000004');
  const a2 = allocateOffcuts({ width: 10, height: 10, quantity: 1 });
  assert.equal(a2.allocationId, 'AL-000002');
  const ing = ingestOffcuts({
    layout: {
      paper: { width: 300, height: 100, kerf: 0, grain: 'along-width' },
      frees: [{ x: 0, y: 0, w: 30, h: 30 }],
    },
  });
  // 前两次手工录入 + 重启后第 4 块手工录入的自动批次已消耗 BATCH-000001～3
  assert.equal(ing.batchId, 'BATCH-000004');

  // 释放已恢复的预占关系
  const rel = releaseAllocations({ allocationIds: ['AL-000001'] });
  assert.equal(rel.releasedCount, 1);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 1); // 第二次预占仍在

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

test('恢复后同批次重复登记仍按来源指纹去重', () => {
  const { dir, file } = tempSnapshot();
  initOffcutStore(file);
  const layoutResult = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 50, h: 40 }],
  };
  const first = ingestOffcuts({ layout: layoutResult, batchId: 'B-DUP' });
  assert.equal(first.ingested, 1);

  // 重启后用同一来源批次重复提交
  initOffcutStore(file);
  const again = ingestOffcuts({ layout: layoutResult, batchId: 'B-DUP' });
  assert.equal(again.ingested, 0);
  assert.equal(again.skipped, 1);
  assert.equal(listOffcuts().summary.total, 1);
  assert.equal(first.offcutIds[0], 'OC-000001');

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

/* ---------------- 快照损坏拒绝启动 ---------------- */

test('快照损坏：JSON 非法时明确拒绝启动（抛 SnapshotCorruptError，不当空库）', () => {
  const { dir, file } = tempSnapshot();
  initOffcutStore(file);
  createOffcut({ width: 100, height: 80 });

  fs.writeFileSync(file, '{ 这不是合法 JSON ,,,', 'utf8');
  assert.throws(() => initOffcutStore(file), (err) => {
    assert.ok(err instanceof SnapshotCorruptError);
    assert.match(err.message, /损坏/);
    return true;
  });

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

test('快照损坏：结构/编号不一致时拒绝启动，且内存未被污染', () => {
  const { dir, file } = tempSnapshot();

  const cases = [
    [{ not: 'a snapshot' }, /版本/],
    [{ version: 1, seq: -1, allocSeq: 0, batchSeq: 0, offcuts: [] }, /非负整数/],
    [{ version: 1, seq: 0, allocSeq: 0, batchSeq: 0, offcuts: [{ id: 'XX-1' }] }, /编号非法/],
    [{
      version: 1, seq: 1, allocSeq: 0, batchSeq: 0,
      offcuts: [{
        id: 'OC-000002', // 编号越界（seq=1）
        paperWidth: 100, paperHeight: 100, kerf: 0, x: 0, y: 0, w: 10, h: 10, area: 100,
        paperGrain: 'along-width', status: 'available', reservation: null,
        source: { type: 'manual' },
      }],
    }, /超出当前序号/],
    [{
      version: 1, seq: 1, allocSeq: 0, batchSeq: 0,
      offcuts: [{
        id: 'OC-000001',
        paperWidth: 100, paperHeight: 100, kerf: 0, x: 0, y: 0, w: 10, h: 10, area: 100,
        paperGrain: 'along-width', status: 'reserved', reservation: null,
        source: { type: 'manual' },
      }],
    }, /缺少预占关系/],
    [{
      version: 1, seq: 1, allocSeq: 1, batchSeq: 0,
      offcuts: [{
        id: 'OC-000001',
        paperWidth: 100, paperHeight: 100, kerf: 0, x: 0, y: 0, w: 10, h: 10, area: 100,
        paperGrain: 'weird-grain', status: 'available', reservation: null,
        source: { type: 'manual' },
      }],
    }, /纸张纹向非法/],
  ];

  for (const [snapshot, re] of cases) {
    fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
    assert.throws(() => initOffcutStore(file), re);
  }

  // 所有拒绝启动的恢复都不得污染当前库存（仍是空库）
  assert.equal(listOffcuts().summary.total, 0);

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

/* ---------------- 写盘失败：库存与编号不前进 ---------------- */

test('写盘失败：手工录入返回 SnapshotIOError，库存与三个编号均不前进', () => {
  const { dir, file } = tempSnapshot();
  const badFile = unwritableSnapshotUnder(dir);
  initOffcutStore(badFile); // 中间路径不存在 → 按空库启动成功

  assert.throws(
    () => createOffcut({ width: 100, height: 80 }),
    (err) => err instanceof SnapshotIOError
  );
  assert.equal(listOffcuts().summary.total, 0);

  // 恢复可写路径后编号从头开始（失败未消耗 OC/BATCH 序号）
  initOffcutStore(file);
  const { offcut } = createOffcut({ width: 100, height: 80 });
  assert.equal(offcut.id, 'OC-000001');
  assert.equal(offcut.source.batchId, 'BATCH-000001');

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

test('写盘失败：预占不占用余料、不取预占单号；释放不改动状态', () => {
  const { dir, file } = tempSnapshot();
  initOffcutStore(file);
  createOffcut({ width: 300, height: 300 });
  const ok = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(ok.allocationId, 'AL-000001');

  // 切换到必然写盘失败的路径（中间路径是普通文件 → 写盘 ENOTDIR，root 下同样稳定）
  const badFile = unwritableSnapshotUnder(dir);
  initOffcutStore(badFile); // 该文件不存在 → 按空库启动成功

  // 坏路径下录入失败：库存仍为空
  assert.throws(() => createOffcut({ width: 200, height: 200 }), SnapshotIOError);
  assert.equal(listOffcuts().summary.total, 0);

  // 空库 + 可行候选不足：缺口路径本就不写盘，返回 shortfall 而非 500
  const gap = allocateOffcuts({ width: 10, height: 10, quantity: 1 });
  assert.equal(gap.status, 'shortfall');

  // 释放一个不存在的单号：校验先失败（400），根本不会走到写盘
  assert.throws(
    () => releaseAllocations({ allocationIds: ['AL-000001'] }),
    /不存在或已释放/
  );

  // 回到好路径：AL-000001 与已预占关系原样保留；坏路径上失败的操作未消耗任何序号
  initOffcutStore(file);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 1);
  const next = allocateOffcuts({ width: 10, height: 10, quantity: 1 });
  assert.equal(next.status, 'shortfall'); // 唯一余料仍被 AL-000001 占用
  releaseAllocations({ allocationIds: ['AL-000001'] });
  const again = allocateOffcuts({ width: 10, height: 10, quantity: 1 });
  assert.equal(again.allocationId, 'AL-000002'); // 不是 AL-000003：坏路径未取号

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

test('写盘失败：目标合法但落盘失败的释放不改动预占状态', () => {
  const { dir, file } = tempSnapshot();
  // 用有效快照占位，再把路径变成“父级是普通文件”：恢复读取同样会 ENOTDIR。
  // 这里改为在可写文件中恢复出已预占库存后，把快照文件本身换成目录，
  // 使 rename 替换（ENOTDIR/EISDIR）失败——root 下同样稳定。
  initOffcutStore(file);
  createOffcut({ width: 300, height: 300 });
  const alloc = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(alloc.allocationId, 'AL-000001');

  // 让 file 成为目录：临时文件先写到同目录，rename 到目录路径必然失败
  fs.unlinkSync(file);
  fs.mkdirSync(file);

  assert.throws(
    () => releaseAllocations({ allocationIds: ['AL-000001'] }),
    (err) => err instanceof SnapshotIOError
  );
  // 发布未发生：预占关系原样保留
  const reserved = listOffcuts({ status: 'reserved' }).offcuts;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].reservation.allocationId, 'AL-000001');

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

test('写盘失败：结果登记整批不落盘、不消耗余料/批次序号，重试成功', () => {
  const { dir, file } = tempSnapshot();
  initOffcutStore(unwritableSnapshotUnder(dir));

  assert.throws(
    () => ingestOffcuts({
      layout: {
        paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
        frees: [{ x: 0, y: 0, w: 50, h: 40 }],
      },
    }),
    SnapshotIOError
  );
  assert.equal(listOffcuts().summary.total, 0);

  // 切到可写路径后重试：编号仍从 1 开始（失败未取号）
  initOffcutStore(file);
  const out = ingestOffcuts({
    layout: {
      paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
      frees: [{ x: 0, y: 0, w: 50, h: 40 }],
    },
  });
  assert.deepEqual(out.offcutIds, ['OC-000001']);
  assert.equal(out.batchId, 'BATCH-000001');

  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

/* ---------------- 原子文件替换 ---------------- */

test('快照目录下不残留临时文件，且快照内容为最新状态', () => {
  const { dir, file } = tempSnapshot();
  initOffcutStore(file);
  for (let i = 0; i < 3; i += 1) createOffcut({ width: 10 + i, height: 10 });
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).seq, 3);
  fs.rmSync(dir, { recursive: true, force: true });
  useEphemeralStore();
});

/* ---------------- 进程级重启（真实 server.js 启动恢复 / 拒绝启动） ---------------- */

const serverBin = path.join(__dirname, '..', 'server.js');

function runServer(env, { waitForReady = false } = {}) {
  const spawn = require('node:child_process').spawn;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverBin], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('等待服务启动超时'));
      }
    }, 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (waitForReady && out.includes('服务已启动') && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, out });
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, signal, out, err });
      }
    });
    if (!waitForReady) {
      // 等待自然退出（用于拒绝启动场景）
    }
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function httpPost(port, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const data = JSON.stringify(bodyObj);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('进程级：真实服务重启后库存与预占经数据文件恢复，同批次重登仍去重', async (t) => {
  const { dir, file } = tempSnapshot();
  const port = 6310 + Math.floor(Math.random() * 300);
  const env = { OFFCUTS_DATA_FILE: file, PORT: String(port) };

  // 第一次启动：录入 + 登记 + 预占
  let srv = await runServer(env, { waitForReady: true });
  t.after(() => { try { srv.child.kill('SIGKILL'); } catch (_) { /* noop */ } });
  let r = await httpPost(port, '/api/offcuts', { paperName: '大块', width: 300, height: 300 });
  assert.equal(r.status, 201);
  r = await httpPost(port, '/api/offcuts/ingest', {
    layout: {
      paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
      frees: [{ x: 0, y: 0, w: 50, h: 40 }],
    },
    batchId: 'PROC-1',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.ingested, 1);
  r = await httpPost(port, '/api/offcuts/allocate', { width: 100, height: 100, quantity: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.allocationId, 'AL-000001');
  srv.child.kill('SIGTERM');
  await new Promise((res) => srv.child.on('exit', res));

  // 第二次启动：验证恢复
  srv = await runServer(env, { waitForReady: true });
  t.after(() => { try { srv.child.kill('SIGKILL'); } catch (_) { /* noop */ } });
  r = await httpGet(port, '/api/offcuts?status=reserved');
  assert.equal(r.status, 200);
  const reserved = JSON.parse(r.body);
  assert.equal(reserved.count, 1);
  assert.equal(reserved.offcuts[0].reservation.allocationId, 'AL-000001');

  // 编号继续递增，不回退
  r = await httpPost(port, '/api/offcuts', { width: 5, height: 5 });
  assert.equal(r.body.offcut.id, 'OC-000003');
  r = await httpPost(port, '/api/offcuts/allocate', { width: 5, height: 5, quantity: 1 });
  assert.equal(r.body.allocationId, 'AL-000002');

  // 恢复后同批次重复登记仍去重
  r = await httpPost(port, '/api/offcuts/ingest', {
    layout: {
      paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
      frees: [{ x: 0, y: 0, w: 50, h: 40 }],
    },
    batchId: 'PROC-1',
  });
  assert.equal(r.body.ingested, 0);
  assert.equal(r.body.skipped, 1);

  // 释放恢复出来的预占关系
  r = await httpPost(port, '/api/offcuts/release', { allocationIds: ['AL-000001'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.releasedCount, 1);

  srv.child.kill('SIGTERM');
  await new Promise((res) => srv.child.on('exit', res));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('进程级：快照损坏时服务拒绝启动（退出码非 0，不监听端口）', async () => {
  const { dir, file } = tempSnapshot();
  const port = 6610 + Math.floor(Math.random() * 300);

  // 先制造一个有效快照
  initOffcutStore(file);
  createOffcut({ width: 100, height: 80 });
  useEphemeralStore();

  fs.writeFileSync(file, '{损坏的快照内容', 'utf8');
  const result = spawnSync(process.execPath, [serverBin], {
    env: { ...process.env, OFFCUTS_DATA_FILE: file, PORT: String(port) },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.notEqual(result.status, 0, '损坏快照时进程应以非 0 退出');
  assert.match(result.stderr + result.stdout, /服务启动失败|损坏/);
  assert.doesNotMatch(result.stdout, /服务已启动/);

  fs.rmSync(dir, { recursive: true, force: true });
});
