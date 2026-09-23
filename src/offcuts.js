'use strict';

/**
 * 余料库存与复用预占（offcut inventory & allocation）
 *
 * 把排料结果中每张纸 layout.frees 的自由矩形标准化为可追踪的余料记录
 * （保留纸型宽高/名称、纸张纹向、刀缝、纸面坐标、尺寸与来源批次），
 * 支持：
 *  - 余料录入（手工录入 / 从单张、批量、多纸型成本、方案比选结果批量登记；
 *    批量登记先校验全部待登记余料，再按来源指纹去重，最后一次性写入——
 *    任一余料无效时库存、预占状态与自动生成的余料/批次序号均不变）；
 *  - 余料查询（可用 / 已预占、最小尺寸、关键字）；
 *  - POST /api/offcuts/allocate 原子复用预占：给定成品宽高、数量与纹向要求，
 *    按旋转 / 纹向可行性与“占用后剩余面积最小”确定性选取余料；
 *    一次请求必须预占足量余料，无法满足时不改动任何记录并返回缺口明细；
 *  - 释放预占（按预占单号 / 余料编号）。
 *
 * 持久化（写前提交 / commit-before-publish）：
 * 手工录入、结果登记、预占、释放四类写操作统一经由持久化提交——
 * 先在状态副本（draft）中完成全部校验、去重与取号，再把目标状态
 * 原子写入本地快照文件（临时文件 fsync 后 rename 替换），写盘成功后
 * 才发布（publish）到进程内存库存；写盘失败抛出 SnapshotIOError，
 * 库存状态与三个自动编号（余料 OC / 预占单 AL / 批次 BATCH）均不前进。
 * 服务启动时 initOffcutStore(file) 从快照恢复余料、预占关系及编号；
 * 快照文件不存在视为空库，文件存在但内容损坏（JSON 非法 / 结构与
 * 编号不一致等）则明确抛错拒绝启动，避免把既有库存误当作空库。
 * 恢复后同批次重复登记仍按来源指纹去重。
 * 未调用 initOffcutStore（或显式 useEphemeralStore）时为纯内存模式，
 * 仅供测试使用；提供 _resetStore() 仅供测试使用。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  normalizePaperGrain,
  normalizeProductGrain,
  grainAllows,
} = require('./packer');

const EPS = 1e-6;
const SNAPSHOT_VERSION = 1;

const round3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- 错误类型 ---------------- */

/** 快照损坏：恢复时文件存在但无法解析 / 内容不合法 → 拒绝启动 */
class SnapshotCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotCorruptError';
  }
}

/** 快照写盘失败：原子提交未落盘 → 库存状态与编号均不发布，服务返回 503 */
class SnapshotIOError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SnapshotIOError';
    this.cause = cause || null;
  }
}

/* ---------------- 存储状态 ---------------- */

/**
 * 持久化句柄：{ kind:'file', file }（启用快照）或
 * { kind:'memory' }（纯内存，测试用）。
 */
let persistence = { kind: 'memory' };

const store = emptyState();

function emptyState() {
  return {
    seq: 0, // 余料记录序号
    allocSeq: 0, // 预占单号序号
    batchSeq: 0, // 自动来源批次序号
    offcuts: new Map(), // id → 记录
  };
}

/**
 * 启动时从快照恢复余料库存。file 不存在时按空库启动（不预先创建文件）；
 * 文件存在但损坏 / 结构与编号不一致时抛 SnapshotCorruptError，
 * 调用方应拒绝继续启动，避免把既有库存当作空库。
 * @param {string} file 快照文件绝对路径
 */
function initOffcutStore(file) {
  if (!file || typeof file !== 'string') {
    throw new Error('余料快照文件路径无效');
  }
  persistence = { kind: 'file', file: path.resolve(file) };

  let text;
  try {
    text = fs.readFileSync(persistence.file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      // 快照文件不存在（ENOTDIR 表示路径某段是普通文件，同样不可能存在快照）
      // → 按空库启动；后续写盘若路径仍不可用会返回服务错误，不会静默丢数据
      store.seq = 0;
      store.allocSeq = 0;
      store.batchSeq = 0;
      store.offcuts.clear();
      return;
    }
    throw new SnapshotCorruptError(`无法读取余料快照 ${persistence.file}：${err.code || err.message}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SnapshotCorruptError(`余料快照 ${persistence.file} 已损坏（JSON 无法解析）：${err.message}`);
  }
  restoreState(store, data, persistence.file);
}

/** 切换为纯内存模式（测试用） */
function useEphemeralStore() {
  persistence = { kind: 'memory' };
  _resetStore();
}

/** 仅供测试：清空库存与全部序号（纯内存模式；文件模式下不删快照） */
function _resetStore() {
  store.seq = 0;
  store.allocSeq = 0;
  store.batchSeq = 0;
  store.offcuts.clear();
}

/* ---------------- 快照序列化 / 校验恢复 ---------------- */

function serializeState(st) {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    seq: st.seq,
    allocSeq: st.allocSeq,
    batchSeq: st.batchSeq,
    offcuts: [...st.offcuts.values()],
  };
}

function failCorrupt(file, detail) {
  throw new SnapshotCorruptError(`余料快照 ${file} 已损坏：${detail}`);
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function nonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * 严格校验快照数据并恢复到 target。任一字段非法都抛 SnapshotCorruptError，
 * 不做静默兜底（静默丢弃记录等于把既有库存当空库）。
 */
function restoreState(target, data, file) {
  if (!isPlainObject(data)) failCorrupt(file, '顶层结构不是对象');
  if (data.version !== SNAPSHOT_VERSION) {
    failCorrupt(file, `不支持的快照版本 ${JSON.stringify(data.version)}（支持版本 ${SNAPSHOT_VERSION}）`);
  }
  if (!nonNegInt(data.seq) || !nonNegInt(data.allocSeq) || !nonNegInt(data.batchSeq)) {
    failCorrupt(file, '自动编号 seq/allocSeq/batchSeq 必须是非负整数');
  }
  if (!Array.isArray(data.offcuts)) failCorrupt(file, 'offcuts 必须是数组');
  if (data.offcuts.length > 500000) failCorrupt(file, '余料记录数超出上限');

  const next = emptyState();
  const seenIds = new Set();
  for (let i = 0; i < data.offcuts.length; i += 1) {
    const rec = data.offcuts[i];
    const at = `第 ${i + 1} 条余料记录`;
    if (!isPlainObject(rec)) failCorrupt(file, `${at}不是对象`);
    if (typeof rec.id !== 'string' || !/^OC-\d{6,}$/.test(rec.id)) {
      failCorrupt(file, `${at}编号非法：${JSON.stringify(rec.id)}`);
    }
    if (seenIds.has(rec.id)) failCorrupt(file, `余料编号重复：${rec.id}`);
    seenIds.add(rec.id);
    const idNum = Number(rec.id.slice(3));
    if (idNum > data.seq) failCorrupt(file, `余料 ${rec.id} 超出当前序号 ${data.seq}`);

    if (!isPlainObject(rec.source)) failCorrupt(file, `${at}缺少 source 来源信息`);
    if (!['single', 'batch', 'cost', 'manual'].includes(rec.source.type)) {
      failCorrupt(file, `${at}来源类型非法：${JSON.stringify(rec.source.type)}`);
    }
    const numFields = ['paperWidth', 'paperHeight', 'kerf', 'x', 'y', 'w', 'h', 'area'];
    for (const f of numFields) {
      if (typeof rec[f] !== 'number' || !Number.isFinite(rec[f]) || rec[f] < 0) {
        failCorrupt(file, `${at}字段 ${f} 必须是非负数字`);
      }
    }
    if (rec.w <= 0 || rec.h <= 0 || rec.paperWidth <= 0 || rec.paperHeight <= 0) {
      failCorrupt(file, `${at}尺寸 / 纸型宽高必须为正数`);
    }
    if (!['along-width', 'along-height'].includes(rec.paperGrain)) {
      failCorrupt(file, `${at}纸张纹向非法：${JSON.stringify(rec.paperGrain)}`);
    }
    if (!['available', 'reserved'].includes(rec.status)) {
      failCorrupt(file, `${at}状态非法：${JSON.stringify(rec.status)}`);
    }
    if (rec.status === 'reserved') {
      const rv = rec.reservation;
      if (!isPlainObject(rv)) failCorrupt(file, `余料 ${rec.id} 已预占但缺少预占关系 reservation`);
      if (typeof rv.allocationId !== 'string' || !/^AL-\d{6,}$/.test(rv.allocationId)) {
        failCorrupt(file, `余料 ${rec.id} 的预占单号非法：${JSON.stringify(rv && rv.allocationId)}`);
      }
      const alNum = Number(rv.allocationId.slice(3));
      if (alNum > data.allocSeq) {
        failCorrupt(file, `预占单 ${rv.allocationId} 超出当前序号 ${data.allocSeq}`);
      }
      if (!isPlainObject(rv.product)) failCorrupt(file, `余料 ${rec.id} 的预占成品信息缺失`);
    } else if (rec.reservation != null) {
      failCorrupt(file, `余料 ${rec.id} 状态为可用却带有预占关系`);
    }
    next.offcuts.set(rec.id, rec);
  }

  // 编号必须能覆盖现存记录（小序号记录可能已随预占关系一起保留，故只校验不越界、不强制连续）
  if (data.seq < next.offcuts.size) {
    failCorrupt(file, `余料序号 ${data.seq} 小于现存记录数 ${next.offcuts.size}`);
  }

  next.seq = data.seq;
  next.allocSeq = data.allocSeq;
  next.batchSeq = data.batchSeq;
  target.seq = next.seq;
  target.allocSeq = next.allocSeq;
  target.batchSeq = next.batchSeq;
  target.offcuts = next.offcuts;
}

/**
 * 原子写快照：同目录临时文件写入并 fsync 后 rename 替换正式文件，
 * 保证快照要么是上一版、要么是新版，不会出现半截文件。
 */
function writeSnapshot(st) {
  if (persistence.kind !== 'file') return; // 纯内存模式（测试）
  const file = persistence.file;
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, JSON.stringify(serializeState(st)), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) { /* 忽略清理错误 */ }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件可能未生成 */ }
    throw new SnapshotIOError(`余料快照写盘失败（本次操作未生效）：${err.code || err.message}`, err);
  }
}

/**
 * 统一持久化提交：在 draft（当前状态的深拷贝）上执行 mutate，
 * mutate 内完成全部校验 / 去重 / 取号并返回结果；成功落盘后才把
 * draft 发布为活动库存。校验错误（mutate 抛错）或写盘失败时，
 * 活动状态与编号均不变。
 */
function commit(mutate) {
  const draft = cloneState(store);
  const result = mutate(draft);
  writeSnapshot(draft);
  publishState(draft);
  return result;
}

function cloneState(st) {
  return {
    seq: st.seq,
    allocSeq: st.allocSeq,
    batchSeq: st.batchSeq,
    offcuts: new Map(
      JSON.parse(JSON.stringify([...st.offcuts.values()])).map((rec) => [rec.id, rec])
    ),
  };
}

function publishState(st) {
  store.seq = st.seq;
  store.allocSeq = st.allocSeq;
  store.batchSeq = st.batchSeq;
  store.offcuts = st.offcuts;
}

function newOffcutIdOn(st) {
  st.seq += 1;
  return `OC-${String(st.seq).padStart(6, '0')}`;
}

function newAllocationIdOn(st) {
  st.allocSeq += 1;
  return `AL-${String(st.allocSeq).padStart(6, '0')}`;
}

function newBatchIdOn(st) {
  st.batchSeq += 1;
  return `BATCH-${String(st.batchSeq).padStart(6, '0')}`;
}

/* ---------------- 输入校验 ---------------- */

function positiveNumber(value, subject) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${subject}必须为正数`);
  return n;
}

function nonNegativeNumber(value, subject) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${subject}必须是非负数字`);
  return n;
}

function positiveInteger(value, subject, max = 100000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${subject}必须是正整数`);
  if (n > max) throw new Error(`${subject}不能超过 ${max}`);
  return n;
}

function normalizeRef(value, subject = '关联单据') {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 128) throw new Error(`${subject}长度不能超过 128 个字符`);
  return s;
}

/** 校验显式来源批次号；未提供时返回 null（是否自动生成由调用方决定时机） */
function explicitBatchId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 128) throw new Error('来源批次号长度不能超过 128 个字符');
  return s;
}

/** 规范化单条余料的纸型 / 几何字段（手工录入与结果登记共用） */
function normalizeOffcutShape(raw, pos) {
  const who = pos ? `第 ${pos} 条余料的` : '';
  const width = positiveNumber(raw.width, `${who}宽度`);
  const height = positiveNumber(raw.height, `${who}高度`);
  const kerf = raw.kerf == null || raw.kerf === '' ? 0 : nonNegativeNumber(raw.kerf, `${who}刀缝宽度`);
  const paperGrain = normalizePaperGrain(raw.paperGrain || raw.grain, '余料纸张');
  return { width, height, kerf, paperGrain };
}

/* ---------------- 记录构造 ---------------- */

/**
 * 校验并规范化一个自由矩形的坐标与尺寸（纯校验，不取号、不写库）。
 * @param {object} free { x, y, w, h }（layout.frees 元素）
 * @param {object} paper { width, height }（已规范化的纸张）
 * @returns {{ x:number, y:number, w:number, h:number }}
 */
function normalizeFreeRect(free, paper) {
  const x = Number(free.x) || 0;
  const y = Number(free.y) || 0;
  const w = positiveNumber(free.w, '余料宽度');
  const h = positiveNumber(free.h, '余料高度');
  if (x < -EPS || y < -EPS) throw new Error('余料坐标不能为负');
  if (x + w > paper.width + EPS || y + h > paper.height + EPS) {
    throw new Error('余料矩形超出纸面范围');
  }
  return { x, y, w, h };
}

/**
 * 由已校验的自由矩形构造余料记录。
 * id 留空（null），由调用方在确定入库时通过 newOffcutIdOn() 赋值，
 * 保证跳过的重复项与校验失败的批次不消耗余料序号。
 * @param {object} rect { x, y, w, h }（normalizeFreeRect 返回）
 * @param {object} paper { width, height, kerf, grain }
 * @param {object} meta { type, batchId, sheetIndex, round, paperId, paperName, orderNo }
 */
function buildRecord(rect, paper, meta) {
  const { x, y, w, h } = rect;
  return {
    id: null,
    paperName: meta.paperName || null,
    paperWidth: round3(paper.width),
    paperHeight: round3(paper.height),
    paperGrain: paper.grain,
    kerf: round3(paper.kerf),
    x: round3(x),
    y: round3(y),
    w: round3(w),
    h: round3(h),
    area: round3(w * h),
    status: 'available', // available（可用） | reserved（已预占）
    source: {
      type: meta.type, // single | batch | cost | manual
      batchId: meta.batchId || null,
      sheetIndex: meta.sheetIndex == null ? null : meta.sheetIndex,
      round: meta.round == null ? null : meta.round,
      paperId: meta.paperId || null,
      orderNo: meta.orderNo == null ? null : meta.orderNo,
      ingestedAt: new Date().toISOString(),
    },
    reservation: null,
  };
}

/* ---------------- 从排料结果登记 ---------------- */

/** 规范化排料结果中的纸张信息（单张 / 批量 / 成本 / 比选登记共用） */
function normalizeLayoutPaper(layoutResult) {
  if (!layoutResult || typeof layoutResult !== 'object' || !layoutResult.paper) {
    throw new Error('缺少有效的单张排料结果（需包含 paper 与 frees）');
  }
  return {
    width: positiveNumber(layoutResult.paper.width, '纸张宽度'),
    height: positiveNumber(layoutResult.paper.height, '纸张高度'),
    kerf: layoutResult.paper.kerf == null ? 0 : nonNegativeNumber(layoutResult.paper.kerf, '刀缝宽度'),
    grain: normalizePaperGrain(layoutResult.paper.grain, '纸张'),
  };
}

/** 从单张 layout() 结果提取余料记录（纯函数：校验 + 构造，不取号、不写库） */
function offcutsFromLayout(layoutResult, meta) {
  const paper = normalizeLayoutPaper(layoutResult);
  const frees = Array.isArray(layoutResult.frees) ? layoutResult.frees : [];
  return frees.map((free) => buildRecord(normalizeFreeRect(free, paper), paper, meta));
}

/**
 * 识别排料结果形态：
 *  - sheets[].layout 存在 → cost（多纸型成本排产）
 *  - sheets 存在         → batch（批量排产）
 *  - candidates 存在     → compare（方案比选，登记当前/最佳候选）
 *  - paper + frees       → single（单张排样）
 */
function detectResultShape(raw) {
  if (Array.isArray(raw.sheets)) {
    return raw.sheets.length && raw.sheets[0] && raw.sheets[0].layout ? 'cost' : 'batch';
  }
  if (Array.isArray(raw.candidates)) return 'compare';
  if (raw.paper && Array.isArray(raw.frees)) return 'single';
  return null;
}

/**
 * 从排料结果批量登记余料。接受请求体中的 layout / result / data 字段，
 * 也可直接把单张 / 批量 / 成本 / 比选返回作为请求体。
 * 同一来源批次（batchId）下纸型、刀缝、坐标、尺寸完全相同的余料不重复登记。
 *
 * 原子性（校验 + 编号 + 落仓 + 持久化一体）：先在状态副本中校验全部待登记
 * 余料（任一无效即整体报错，活动库存与编号不动），再按来源指纹处理库内与
 * 本次请求内的重复项，一次性取号写入副本；副本原子落盘成功后才发布。
 * 写盘失败时库存、预占状态与自动生成的余料/批次序号均不变，修正后重试
 * 不会出现跳过记录或编号错位。
 *
 * @returns {{ batchId, ingested:number, skipped:number, offcutIds:string[] }}
 */
function ingestOffcuts(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少排料结果');
  const raw = input.layout || input.result || input.data || input;
  const shape = detectResultShape(raw);
  if (!shape) {
    throw new Error('无法识别排料结果（需为单张 layout.frees、批量/成本 sheets 或方案比选 candidates）');
  }
  // 显式批次号先校验格式；缺省时的自动批次号留待全部校验通过后再取号，
  // 保证任一余料无效时批次序号不前进
  const givenBatchId = explicitBatchId(input.batchId);

  const plans = []; // [{ layout, meta }]（meta.batchId 待批次号确定后统一填入）
  if (shape === 'single') {
    plans.push({
      layout: raw,
      meta: { type: 'single', sheetIndex: 1 },
    });
  } else if (shape === 'compare') {
    // 方案比选：登记中选方案；全部排不进（best 为 null）时登记首个候选
    const chosen = raw.best
      ? raw.best.layout
      : (raw.candidates[0] && raw.candidates[0].layout);
    if (!chosen) throw new Error('方案比选结果中没有可登记的布局');
    plans.push({
      layout: chosen,
      meta: { type: 'single', sheetIndex: 1 },
    });
  } else if (shape === 'batch') {
    raw.sheets.forEach((sh, i) => {
      plans.push({
        layout: sh,
        meta: {
          type: 'batch', sheetIndex: i + 1,
          round: sh.round || i + 1, orderNo: sh.orderNo == null ? null : sh.orderNo,
        },
      });
    });
  } else {
    raw.sheets.forEach((sh, i) => {
      plans.push({
        layout: sh.layout,
        meta: {
          type: 'cost', sheetIndex: i + 1,
          round: sh.round, paperId: sh.paperId, paperName: sh.paperName,
          orderNo: sh.orderNo == null ? null : sh.orderNo,
        },
      });
    });
  }

  return commit((st) => {
    // 第一阶段：校验全部纸张与待登记余料（纯校验，不取号、不写库）
    const pending = []; // [{ rect, paper, meta }]
    for (const plan of plans) {
      const paper = normalizeLayoutPaper(plan.layout);
      const frees = Array.isArray(plan.layout.frees) ? plan.layout.frees : [];
      for (const free of frees) {
        pending.push({ rect: normalizeFreeRect(free, paper), paper, meta: plan.meta });
      }
    }

    // 全部校验通过后才确定来源批次号（缺省时此刻才消耗自动批次序号）
    const batchId = givenBatchId || newBatchIdOn(st);

    // 第二阶段：同一来源（批次 + 纸张序号）下纸型、刀缝、坐标、尺寸完全相同的
    // 余料不重复登记；跨请求（含重启恢复后）对同一 batchId 重复提交同样去重
    const fingerprints = new Set();
    for (const rec of st.offcuts.values()) fingerprints.add(fingerprintOf(rec));

    const seen = new Set(); // 本次请求内的指纹（与库内指纹一并判重）
    const accepted = [];
    let skipped = 0;
    for (const item of pending) {
      const rec = buildRecord(item.rect, item.paper, { ...item.meta, batchId });
      const fp = fingerprintOf(rec);
      if (seen.has(fp) || fingerprints.has(fp)) {
        skipped += 1;
        continue;
      }
      seen.add(fp);
      accepted.push(rec);
    }

    // 第三阶段：一次性取号写入副本（只有确定入库的记录才消耗余料序号）
    const ingested = [];
    for (const rec of accepted) {
      rec.id = newOffcutIdOn(st);
      st.offcuts.set(rec.id, rec);
      ingested.push(rec);
    }

    return {
      batchId,
      shape,
      ingested: ingested.length,
      skipped,
      offcutIds: ingested.map((r) => r.id),
      summary: inventorySummaryOn(st),
    };
  });
}

/* ---------------- 手工录入 ---------------- */

/**
 * 手工录入一条余料（切下后留存的矩形，无原纸面坐标时坐标取 0,0）。
 * 校验 / 取号在状态副本内完成，快照原子落盘成功后才发布。
 * @param {object} input { paperName?, width, height, paperGrain?|grain?, kerf?, batchId?, orderNo?, note? }
 */
function createOffcut(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少余料信息');
  const shape = normalizeOffcutShape(input);
  const paperName = input.paperName != null ? String(input.paperName).trim() : '';
  const orderNo = normalizeRef(input.orderNo, '订单号');
  const givenBatchId = explicitBatchId(input.batchId);
  const note = input.note != null && input.note !== '' ? String(input.note).slice(0, 256) : null;

  return commit((st) => {
    const free = { x: 0, y: 0, w: shape.width, h: shape.height };
    const rec = buildRecord(free, {
      width: shape.width,
      height: shape.height,
      kerf: shape.kerf,
      grain: shape.paperGrain,
    }, {
      type: 'manual',
      batchId: givenBatchId || newBatchIdOn(st),
      sheetIndex: null,
      paperName: paperName || null,
      orderNo,
    });
    if (note) rec.source.note = note;
    rec.id = newOffcutIdOn(st);
    st.offcuts.set(rec.id, rec);
    return { offcut: rec, summary: inventorySummaryOn(st) };
  });
}

/* ---------------- 查询 ---------------- */

function inventorySummary() {
  return inventorySummaryOn(store);
}

function inventorySummaryOn(st) {
  let available = 0;
  let reserved = 0;
  let availableArea = 0;
  let reservedArea = 0;
  for (const rec of st.offcuts.values()) {
    if (rec.status === 'reserved') {
      reserved += 1;
      reservedArea += rec.area;
    } else {
      available += 1;
      availableArea += rec.area;
    }
  }
  return {
    total: st.offcuts.size,
    available,
    reserved,
    availableArea: round3(availableArea),
    reservedArea: round3(reservedArea),
    totalArea: round3(availableArea + reservedArea),
  };
}

/**
 * 查询余料。
 * @param {object} query
 *   status?: 'all'（缺省）| 'available' | 'reserved'
 *   minW?, minH?: 要求余料某种朝向下至少能容纳 minW×minH
 *   grain?: 仅返回该纸张纹向的余料
 *   q?: 关键字（纸型名称 / 来源批次 / 订单号）
 */
function listOffcuts(query = {}) {
  const status = query.status == null || query.status === '' ? 'all' : String(query.status);
  if (!['all', 'available', 'reserved'].includes(status)) {
    throw new Error('状态筛选必须是 all、available 或 reserved');
  }
  const minW = query.minW == null || query.minW === '' ? null : positiveNumber(query.minW, '最小宽');
  const minH = query.minH == null || query.minH === '' ? null : positiveNumber(query.minH, '最小高');
  let grain = null;
  if (query.grain != null && query.grain !== '') grain = normalizePaperGrain(query.grain, '筛选纹向');
  const kw = query.q != null ? String(query.q).trim().toLowerCase() : '';

  const fitsMin = (rec) => {
    if (minW == null) return true;
    // 允许旋转 90° 比较
    return (rec.w >= minW - EPS && rec.h >= minH - EPS)
      || (rec.w >= minH - EPS && rec.h >= minW - EPS);
  };

  const list = [];
  for (const rec of store.offcuts.values()) {
    if (status !== 'all' && rec.status !== status) continue;
    if (grain && rec.paperGrain !== grain) continue;
    if (!fitsMin(rec)) continue;
    if (kw) {
      const hay = [rec.paperName, rec.source.batchId, rec.source.orderNo, rec.id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    list.push(rec);
  }

  // 确定性排序：可用优先（查询已固定状态时无影响）、面积降序、编号升序
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'available' ? -1 : 1;
    if (Math.abs(b.area - a.area) > EPS) return b.area - a.area;
    return offcutSeq(a.id) - offcutSeq(b.id);
  });

  return { summary: inventorySummary(), count: list.length, offcuts: list };
}

function offcutSeq(id) {
  const n = Number(String(id).replace(/^OC-/, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 余料去重指纹：来源（类型/批次/纸张序号/轮次）+ 纸型/刀缝 + 坐标尺寸 */
function fingerprintOf(rec) {
  return [
    rec.source.type, rec.source.batchId, rec.source.sheetIndex, rec.source.round,
    rec.paperWidth, rec.paperHeight, rec.paperGrain, rec.kerf,
    rec.x, rec.y, rec.w, rec.h,
  ].join('|');
}

/* ---------------- 复用预占（原子分配） ---------------- */

/**
 * 计算成品（pw×ph，纹向要求 grain）在余料 rec 上的可行放置。
 * @returns 可行时 { rotated, placedW, placedH, residualArea }，否则 { blocked:'too-small'|'grain-blocked' }
 */
function feasiblePlacement(rec, pw, ph, grain) {
  const fitsNoRotate = pw <= rec.w + EPS && ph <= rec.h + EPS;
  const fitsRotate = ph <= rec.w + EPS && pw <= rec.h + EPS;
  const options = [];
  if (fitsNoRotate && grainAllows(grain, rec.paperGrain, false)) {
    options.push({ rotated: false, placedW: pw, placedH: ph });
  }
  if (fitsRotate && grainAllows(grain, rec.paperGrain, true)) {
    options.push({ rotated: true, placedW: ph, placedH: pw });
  }
  if (options.length === 0) {
    // 几何上任一朝向能放下，但纹向允许的朝向放不下 → 纹向受限；否则尺寸不足
    const geometricFit = fitsNoRotate || fitsRotate;
    return { blocked: geometricFit ? 'grain-blocked' : 'too-small' };
  }
  // 同一余料上两种朝向都可行时，取占用后剩余面积更小的朝向（平局不旋转优先）
  options.sort((a, b) => {
    const ra = rec.area - a.placedW * a.placedH;
    const rb = rec.area - b.placedW * b.placedH;
    if (Math.abs(ra - rb) > EPS) return ra - rb;
    return (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0);
  });
  const pick = options[0];
  return {
    rotated: pick.rotated,
    placedW: round3(pick.placedW),
    placedH: round3(pick.placedH),
    residualArea: round3(rec.area - pick.placedW * pick.placedH),
  };
}

/**
 * 原子复用预占：
 *  1. 仅在“可用”余料中按旋转 / 纹向可行性收集候选；
 *  2. 候选决胜（全部确定性）：占用后剩余面积 ↑小 → 余料面积 ↑小 →
 *     余料短边 ↑小 → 余料长边 ↑小 → 不旋转优先 → 余料编号 ↑小（录入先后）；
 *  3. 可满足（候选数 ≥ 数量）才在状态副本内一次性预占并取预占单号，
 *     副本原子落盘成功后才发布；无法满足时不改动任何记录（不进入提交），
 *     返回缺口明细。
 *
 * @param {object} input { width, height, quantity, grain?, ref? }
 */
function allocateOffcuts(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少预占请求');
  const width = positiveNumber(input.width, '成品宽度');
  const height = positiveNumber(input.height, '成品高度');
  const quantity = positiveInteger(input.quantity, '预占数量');
  const grain = normalizeProductGrain(input.grain);
  const ref = normalizeRef(input.ref);

  const candidates = [];
  let blockedTooSmall = 0;
  let blockedGrain = 0;
  let reservedCount = 0;
  for (const rec of store.offcuts.values()) {
    if (rec.status === 'reserved') { reservedCount += 1; continue; }
    const placement = feasiblePlacement(rec, width, height, grain);
    if (placement.blocked) {
      if (placement.blocked === 'grain-blocked') blockedGrain += 1;
      else blockedTooSmall += 1;
      continue;
    }
    candidates.push({ rec, ...placement });
  }

  const request = {
    width: round3(width), height: round3(height), quantity, grain, ref,
  };

  // 无法满足：原子失败——不预占任何余料、不取预占单号、不触发落盘，返回缺口明细
  if (candidates.length < quantity) {
    candidates.sort(compareCandidates);
    return {
      status: 'shortfall',
      allocated: false,
      request,
      summary: inventorySummary(),
      feasibleCount: candidates.length,
      reservedCount: 0,
      shortfall: quantity - candidates.length,
      blockedBySize: blockedTooSmall,
      blockedByGrain: blockedGrain,
      unavailableReserved: reservedCount,
      candidates: candidates.map((c) => ({
        offcutId: c.rec.id,
        paperName: c.rec.paperName,
        width: c.rec.w,
        height: c.rec.h,
        paperGrain: c.rec.paperGrain,
        rotated: c.rotated,
        residualArea: c.residualArea,
      })),
    };
  }

  // 确定性择优排序后取前 quantity 条，在副本中一次性提交（先算后改，保证原子语义）
  candidates.sort(compareCandidates);
  const chosen = candidates.slice(0, quantity);

  return commit((st) => {
    const allocationId = newAllocationIdOn(st);
    const now = new Date().toISOString();
    const reserved = chosen.map((c) => {
      const rec = st.offcuts.get(c.rec.id);
      rec.status = 'reserved';
      rec.reservation = {
        allocationId,
        product: { width: round3(width), height: round3(height), grain },
        rotated: c.rotated,
        placedW: c.placedW,
        placedH: c.placedH,
        ref,
        createdAt: now,
      };
      return {
        offcutId: rec.id,
        paperName: rec.paperName,
        width: rec.w,
        height: rec.h,
        paperGrain: rec.paperGrain,
        area: rec.area,
        rotated: c.rotated,
        placedW: c.placedW,
        placedH: c.placedH,
        residualArea: c.residualArea,
        source: rec.source,
      };
    });

    return {
      status: 'fulfilled',
      allocated: true,
      allocationId,
      request,
      summary: inventorySummaryOn(st),
      feasibleCount: candidates.length,
      reservedCount: reserved.length,
      shortfall: 0,
      reserved,
    };
  });
}

/** 候选决胜：剩余面积小 → 余料面积小 → 短边小 → 长边小 → 不旋转 → 录入先后 */
function compareCandidates(a, b) {
  const keys = [
    () => a.residualArea - b.residualArea,
    () => a.rec.area - b.rec.area,
    () => Math.min(a.rec.w, a.rec.h) - Math.min(b.rec.w, b.rec.h),
    () => Math.max(a.rec.w, a.rec.h) - Math.max(b.rec.w, b.rec.h),
    () => (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0),
    () => offcutSeq(a.rec.id) - offcutSeq(b.rec.id),
  ];
  for (const fn of keys) {
    const d = fn();
    if (Math.abs(d) > EPS) return d;
  }
  return 0;
}

/* ---------------- 释放预占 ---------------- */

/**
 * 释放预占：可按预占单号 allocationIds 或余料编号 offcutIds 释放。
 * 编号不存在或对应余料未预占均抛错（调用方返回 HTTP 400），全部校验
 * 在状态副本中通过后才一次性释放，副本原子落盘成功后才发布。
 * @returns {{ releasedCount, allocationIds, offcutIds, reservations:[...], summary }}
 */
function releaseAllocations(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少释放请求');
  const allocationIds = normalizeIdList(input.allocationIds, 'allocationIds');
  const offcutIds = normalizeIdList(input.offcutIds, 'offcutIds');
  if (allocationIds.length === 0 && offcutIds.length === 0) {
    throw new Error('需提供要释放的预占单号（allocationIds）或余料编号（offcutIds）');
  }

  return commit((st) => {
    const targets = new Map(); // id(offcut) → 记录（副本内），去重
    for (const aid of allocationIds) {
      const hits = [...st.offcuts.values()].filter((r) => r.reservation
        && r.reservation.allocationId === aid);
      if (hits.length === 0) throw new Error(`预占单号不存在或已释放：${aid}`);
      for (const rec of hits) targets.set(rec.id, rec);
    }
    for (const oid of offcutIds) {
      const rec = st.offcuts.get(oid);
      if (!rec) throw new Error(`余料编号不存在：${oid}`);
      if (rec.status !== 'reserved') throw new Error(`余料 ${oid} 当前未处于预占状态，无需释放`);
      targets.set(rec.id, rec);
    }

    // 校验全部通过后原子释放
    const touchedAllocations = new Set();
    const reservations = [];
    for (const rec of targets.values()) {
      touchedAllocations.add(rec.reservation.allocationId);
      reservations.push({ offcutId: rec.id, allocationId: rec.reservation.allocationId });
      rec.status = 'available';
      rec.reservation = null;
    }
    reservations.sort((a, b) => offcutSeq(a.offcutId) - offcutSeq(b.offcutId));

    return {
      releasedCount: targets.size,
      allocationIds: [...touchedAllocations].sort(),
      offcutIds: reservations.map((r) => r.offcutId),
      reservations,
      summary: inventorySummaryOn(st),
    };
  });
}

function normalizeIdList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} 含无效编号`);
    out.push(v.trim());
  }
  return [...new Set(out)];
}

module.exports = {
  _resetStore,
  initOffcutStore,
  useEphemeralStore,
  SnapshotIOError,
  SnapshotCorruptError,
  inventorySummary,
  offcutsFromLayout,
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
  feasiblePlacement,
};
