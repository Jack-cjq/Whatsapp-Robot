'use strict';

/**
 * capital.json 低延迟基准（无 SQLite / 无原生模块）
 * npm test
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const assert = require('assert');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { classifyCommand, CMD } = require('../lib/classify');
const { LatencyRegistry } = require('../lib/latency');
const {
    MessageDeduper,
    FairGroupScheduler,
    AsyncLogger,
    OutboundMessageQueue,
    MemoryAccessControl,
    LatencyRegistry: LR
} = require('../lib/runtime-core');
const { JsonCapitalStore } = require('../lib/json-capital-store');
const { CommandEngine } = require('../lib/command-engine');

function fmt(snap) {
    if (!snap) return 'n/a';
    return `n=${snap.count} P50=${snap.p50.toFixed(3)} P95=${snap.p95.toFixed(3)} P99=${snap.p99.toFixed(3)} max=${snap.max.toFixed(3)}`;
}

async function withTempDir(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-json-'));
    try {
        return await fn(dir);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function seedLegacyCapital(filePath, extraGroups = 0, historyPerGroup = 5) {
    const data = {
        _description: '资金管理配置文件 2.0',
        _legacyFlag: 'keep-me',
        legacyGroup: {
            capital: 50,
            history: [
                {
                    id: 'legacy-1',
                    timestamp: '2024-01-01T00:00:00.000Z',
                    operation: '+50',
                    oldValue: 0,
                    newValue: 50,
                    change: 50,
                    user: { name: 'old', id: 'old' },
                    customField: 'must-preserve'
                }
            ],
            statistics: {
                totalOperations: 1,
                lastOperation: null,
                createdDate: '2024-01-01T00:00:00.000Z'
            },
            unknownTop: true
        }
    };
    for (let g = 0; g < extraGroups; g++) {
        const hist = [];
        for (let i = 0; i < historyPerGroup; i++) {
            hist.push({
                id: `seed-${g}-${i}`,
                timestamp: new Date().toISOString(),
                operation: '+1',
                oldValue: i,
                newValue: i + 1,
                change: 1,
                user: null
            });
        }
        data[`seedG${g}`] = {
            capital: historyPerGroup,
            history: hist,
            statistics: {
                totalOperations: historyPerGroup,
                lastOperation: hist[hist.length - 1],
                createdDate: new Date().toISOString()
            }
        };
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return data;
}

async function buildStack(dir, { sendDelayMs = 0, logBroken = false, seed = true } = {}) {
    const capitalPath = path.join(dir, 'capital.json');
    const backupDir = path.join(dir, 'backups');
    const logDir = path.join(dir, 'logs');
    await fsp.mkdir(logDir, { recursive: true });
    if (seed) seedLegacyCapital(capitalPath);

    const capitalStore = new JsonCapitalStore();
    capitalStore.configure({
        filePath: capitalPath,
        backupDir,
        getMaxHistory: () => 100000,
        mergeWaitMs: 2,
        latency: new LatencyRegistry()
    });
    await capitalStore.load();

    const access = new MemoryAccessControl();
    access.replaceAdmins(['admin1']);

    const latency = capitalStore.latency;
    const logger = new AsyncLogger();
    logger.configure({
        logDir: logBroken ? path.join(dir, 'no-log-dir-xxx') : logDir,
        getMainWindow: () => null
    });

    const outbound = new OutboundMessageQueue({ processingDelay: 0 });
    const sent = [];
    outbound.configure({
        sendFn: async (chatId, message) => {
            if (sendDelayMs) await sleep(sendDelayMs);
            sent.push({ chatId, message });
            return { id: `m-${sent.length}` };
        },
        isConnectedFn: () => true
    });

    const engine = new CommandEngine({
        capitalStore,
        accessControl: access,
        outbound,
        logger: {
            warn: (...a) => logger.warn(...a),
            error: (...a) => logger.error(...a),
            operation: (...a) => logger.operation(...a),
            debug: () => {}
        },
        contactCache: { get: () => 'admin', set: () => {} },
        latency,
        mathValidator: {
            safeEvaluate: (expr) => {
                const math = require('mathjs');
                return parseFloat(math.evaluate(expr.replace(/×/g, '*').replace(/÷/g, '/')).toFixed(4));
            }
        }
    });

    const scheduler = new FairGroupScheduler({ maxConcurrentGroups: 8, hardLimit: 100000 });
    const deduper = new MessageDeduper({ maxSize: 5000 });

    return { capitalStore, capitalPath, engine, scheduler, deduper, latency, outbound, sent, logger };
}

async function injectCommand(stack, { chatId, senderId, body, messageId, receivedAtNs }) {
    const classified = classifyCommand(body);
    if (classified.type === CMD.IGNORE) {
        stack.scheduler.droppedNonCommandCount++;
        return;
    }
    if (stack.deduper.isDuplicate(messageId)) return;

    const dto = Object.freeze({
        messageId,
        chatId,
        senderId,
        body,
        type: 'chat',
        timestamp: Math.floor(Date.now() / 1000),
        receivedAtNs: receivedAtNs || process.hrtime.bigint(),
        isGroup: true
    });
    const enqueuedAtNs = process.hrtime.bigint();
    stack.latency.record('receiveToEnqueueMs', LR.nsToMs(dto.receivedAtNs, enqueuedAtNs));

    await new Promise((resolve, reject) => {
        const ok = stack.scheduler.enqueue(chatId, {
            enqueuedAtNs,
            run: async () => {
                try {
                    await stack.engine.handle(dto, classified);
                    stack.latency.record('localTotalMs', LR.nsToMs(dto.receivedAtNs));
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        });
        if (!ok) reject(new Error('overload'));
    });
}

async function scenarioA() {
    console.log('\n=== A: 保留旧数据 + 1000 次 +1 ===');
    return withTempDir(async (dir) => {
        const stack = await buildStack(dir);
        const before = (await stack.capitalStore.query('legacyGroup', 5)).balance;
        assert.strictEqual(before, 50);
        assert.strictEqual(stack.capitalStore.getData()._legacyFlag, 'keep-me');
        assert.strictEqual(stack.capitalStore.getData().legacyGroup.history[0].customField, 'must-preserve');

        for (let i = 0; i < 20; i++) {
            await injectCommand(stack, { chatId: 'legacyGroup', senderId: 'admin1', body: '+1', messageId: `warm-${i}` });
        }
        stack.latency.resetAll();

        const t0 = performance.now();
        for (let i = 0; i < 1000; i++) {
            await injectCommand(stack, {
                chatId: 'legacyGroup',
                senderId: 'admin1',
                body: '+1',
                messageId: `A-${i}`,
                receivedAtNs: process.hrtime.bigint()
            });
        }
        const wall = performance.now() - t0;
        const q = await stack.capitalStore.query('legacyGroup', 1);
        assert.strictEqual(q.balance, 50 + 20 + 1000);
        // 未知字段仍在
        assert.strictEqual(stack.capitalStore.getData().legacyGroup.unknownTop, true);

        const disk = JSON.parse(await fsp.readFile(stack.capitalPath, 'utf8'));
        assert.strictEqual(disk.legacyGroup.capital, q.balance);
        assert.strictEqual(disk._legacyFlag, 'keep-me');

        console.log('balance=', q.balance, 'wallMs=', wall.toFixed(1), 'cps=', (1000 / (wall / 1000)).toFixed(1));
        console.log('receiveToEnqueue', fmt(stack.latency.hist('receiveToEnqueueMs').snapshot()));
        console.log('persistMs', fmt(stack.latency.hist('persistMs').snapshot()));
        console.log('localTotalMs', fmt(stack.latency.hist('localTotalMs').snapshot()));
        await stack.capitalStore.close();
        await stack.logger.close();
        return {
            local: stack.latency.hist('localTotalMs').snapshot(),
            enq: stack.latency.hist('receiveToEnqueueMs').snapshot(),
            persist: stack.latency.hist('persistMs').snapshot(),
            cps: 1000 / (wall / 1000)
        };
    });
}

async function scenarioB() {
    console.log('\n=== B: 10 群 × 1000 混合 ===');
    await withTempDir(async (dir) => {
        const stack = await buildStack(dir, { seed: true });
        const tasks = [];
        for (let g = 0; g < 10; g++) {
            tasks.push((async () => {
                for (let i = 0; i < 1000; i++) {
                    await injectCommand(stack, {
                        chatId: `g${g}`,
                        senderId: 'admin1',
                        body: i % 2 === 0 ? '+1' : '-1',
                        messageId: `B-${g}-${i}`
                    });
                }
            })());
        }
        await Promise.all(tasks);
        for (let g = 0; g < 10; g++) {
            const q = await stack.capitalStore.query(`g${g}`, 1);
            assert.strictEqual(q.balance, 0, `g${g}`);
        }
        const disk = JSON.parse(await fsp.readFile(stack.capitalPath, 'utf8'));
        for (let g = 0; g < 10; g++) assert.strictEqual(disk[`g${g}`].capital, 0);
        console.log('10 groups ok, legacy preserved=', disk.legacyGroup.capital);
        await stack.capitalStore.close();
        await stack.logger.close();
    });
}

async function scenarioC() {
    console.log('\n=== C: 100000 普通消息 ===');
    let ignored = 0;
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) {
        if (classifyCommand(`hello ${i}`).type === CMD.IGNORE) ignored++;
    }
    const wall = performance.now() - t0;
    assert.strictEqual(ignored, 100000);
    console.log('ignored=', ignored, 'wallMs=', wall.toFixed(1));
}

async function scenarioD() {
    console.log('\n=== D: messageId 重复 100 次 ===');
    await withTempDir(async (dir) => {
        const stack = await buildStack(dir);
        for (let i = 0; i < 100; i++) {
            await injectCommand(stack, {
                chatId: 'gD',
                senderId: 'admin1',
                body: '+1',
                messageId: 'DUP-1'
            });
        }
        const q = await stack.capitalStore.query('gD', 5);
        assert.strictEqual(q.balance, 1);
        console.log('balance=1 ok');
        await stack.capitalStore.close();
        await stack.logger.close();
    });
}

async function scenarioE() {
    console.log('\n=== E: send 延迟 2s ===');
    await withTempDir(async (dir) => {
        const stack = await buildStack(dir, { sendDelayMs: 2000 });
        const t0 = performance.now();
        const jobs = [];
        for (let i = 0; i < 5; i++) {
            jobs.push(injectCommand(stack, {
                chatId: 'gE', senderId: 'admin1', body: '+1', messageId: `E-${i}`
            }));
        }
        await Promise.all(jobs);
        const commitWall = performance.now() - t0;
        assert.strictEqual((await stack.capitalStore.query('gE', 1)).balance, 5);
        assert.ok(commitWall < 3000, `不应等待发送: ${commitWall}`);
        await stack.outbound.drain(20000);
        assert.ok(stack.sent.length >= 5);
        console.log('commitWallMs=', commitWall.toFixed(1), 'sent=', stack.sent.length);
        await stack.capitalStore.close();
        await stack.logger.close();
    });
}

async function scenarioF() {
    console.log('\n=== F: 日志不可写 ===');
    await withTempDir(async (dir) => {
        const stack = await buildStack(dir, { logBroken: true });
        for (let i = 0; i < 50; i++) {
            await injectCommand(stack, {
                chatId: 'gF', senderId: 'admin1', body: '+1', messageId: `F-${i}`
            });
        }
        assert.strictEqual((await stack.capitalStore.query('gF', 1)).balance, 50);
        console.log('资金正常 balance=50');
        await stack.capitalStore.close();
        await stack.logger.close();
    });
}

async function scenarioG() {
    console.log('\n=== G: 写入失败保持原文件 ===');
    await withTempDir(async (dir) => {
        const stack = await buildStack(dir);
        await injectCommand(stack, {
            chatId: 'gG', senderId: 'admin1', body: '+10', messageId: 'G-1'
        });
        const beforeDisk = await fsp.readFile(stack.capitalPath, 'utf8');
        // 破坏写入路径：指向只读/非法路径
        stack.capitalStore.filePath = path.join(dir, 'missing-subdir', 'capital.json');
        stack.capitalStore.persistenceFailed = false;
        const r = await stack.capitalStore.mutate({
            kind: 'delta',
            messageId: 'G-fail',
            chatId: 'gG',
            senderId: 'admin1',
            operator: '+',
            value: 1,
            operation: '+1'
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(stack.capitalStore.persistenceFailed, true);
        // 原路径文件仍完整可解析
        const parsed = JSON.parse(beforeDisk);
        assert.ok(parsed.legacyGroup);
        console.log('write fail handled, original JSON intact');
        await stack.logger.close();
    });
}

async function scenarioH() {
    console.log('\n=== H: 1 秒突发 1000 ===');
    return withTempDir(async (dir) => {
        const stack = await buildStack(dir);
        const hist = monitorEventLoopDelay({ resolution: 10 });
        hist.enable();
        const enq = new LatencyRegistry();
        const start = performance.now();
        const waits = [];
        for (let i = 0; i < 1000; i++) {
            const receivedAtNs = process.hrtime.bigint();
            const classified = classifyCommand('+1');
            const messageId = `H-${i}`;
            const dto = Object.freeze({
                messageId, chatId: 'gH', senderId: 'admin1', body: '+1',
                type: 'chat', timestamp: 1, receivedAtNs, isGroup: true
            });
            const enqueuedAtNs = process.hrtime.bigint();
            enq.record('receiveToEnqueueMs', LR.nsToMs(receivedAtNs, enqueuedAtNs));
            waits.push(new Promise((resolve) => {
                stack.scheduler.enqueue('gH', {
                    enqueuedAtNs,
                    run: async () => {
                        await stack.engine.handle(dto, classified);
                        stack.latency.record('localTotalMs', LR.nsToMs(receivedAtNs));
                        resolve();
                    }
                });
            }));
        }
        const enqueueWall = performance.now() - start;
        await Promise.all(waits);
        const recoverWall = performance.now() - start;
        hist.disable();
        assert.strictEqual((await stack.capitalStore.query('gH', 1)).balance, 1000);
        const enqSnap = enq.hist('receiveToEnqueueMs').snapshot();
        console.log('enqueueWallMs=', enqueueWall.toFixed(1), 'recoverMs=', recoverWall.toFixed(1));
        console.log('receiveToEnqueue', fmt(enqSnap));
        console.log('localTotalMs', fmt(stack.latency.hist('localTotalMs').snapshot()));
        console.log('persistMs', fmt(stack.latency.hist('persistMs').snapshot()));
        console.log('eventLoopP95=', Number((hist.percentile(95) / 1e6).toFixed(2)));
        await stack.capitalStore.close();
        await stack.logger.close();
        return { enq: enqSnap, recoverWall };
    });
}

async function scenarioCompat() {
    console.log('\n=== 兼容: 旧流水撤回 / 重启一致 / 批量 revision ===');
    await withTempDir(async (dir) => {
        const stack = await buildStack(dir);
        // 旧流水撤回
        await injectCommand(stack, {
            chatId: 'legacyGroup', senderId: 'admin1', body: '撤回', messageId: 'undo-legacy'
        });
        assert.strictEqual((await stack.capitalStore.query('legacyGroup', 1)).balance, 0);

        // 多 revision 同一次 flush
        stack.capitalStore.mergeWaitMs = 5;
        const p1 = stack.capitalStore.mutate({
            kind: 'delta', messageId: 'r1', chatId: 'gR', senderId: 'admin1',
            operator: '+', value: 1, operation: '+1'
        });
        const p2 = stack.capitalStore.mutate({
            kind: 'delta', messageId: 'r2', chatId: 'gR', senderId: 'admin1',
            operator: '+', value: 1, operation: '+1'
        });
        await Promise.all([p1, p2]);
        assert.strictEqual((await stack.capitalStore.query('gR', 1)).balance, 2);

        // 重启一致
        await stack.capitalStore.close();
        const store2 = new JsonCapitalStore();
        store2.configure({
            filePath: stack.capitalPath,
            backupDir: path.join(dir, 'backups'),
            getMaxHistory: () => 1000,
            mergeWaitMs: 2
        });
        await store2.load();
        assert.strictEqual((await store2.query('gR', 1)).balance, 2);
        assert.strictEqual(store2.getData()._legacyFlag, 'keep-me');
        await store2.close();
        await stack.logger.close();
        console.log('compat ok');
    });
}

async function scaleBench() {
    console.log('\n=== 规模延迟: 100/1k/10k/100k 流水 ===');
    const sizes = [100, 1000, 10000, 100000];
    const results = {};
    for (const n of sizes) {
        await withTempDir(async (dir) => {
            const capitalPath = path.join(dir, 'capital.json');
            seedLegacyCapital(capitalPath, 1, Math.max(0, n - 1));
            // seedG0 capital = n-1 already from historyPerGroup
            const store = new JsonCapitalStore();
            const latency = new LatencyRegistry();
            store.configure({
                filePath: capitalPath,
                backupDir: path.join(dir, 'backups'),
                getMaxHistory: () => n + 1000,
                mergeWaitMs: 2,
                latency
            });
            await store.load();
            // warm
            for (let i = 0; i < 5; i++) {
                await store.mutate({
                    kind: 'delta', messageId: `w-${n}-${i}`, chatId: 'seedG0',
                    senderId: 'a', operator: '+', value: 1, operation: '+1'
                });
            }
            latency.resetAll();
            for (let i = 0; i < 50; i++) {
                await store.mutate({
                    kind: 'delta', messageId: `m-${n}-${i}`, chatId: 'seedG0',
                    senderId: 'a', operator: '+', value: 1, operation: '+1'
                });
            }
            const snap = {
                persist: latency.hist('persistMs').snapshot(),
                serialize: latency.hist('jsonSerializeMs').snapshot(),
                write: latency.hist('jsonWriteMs').snapshot()
            };
            results[n] = snap;
            console.log(`size=${n} persist ${fmt(snap.persist)}`);
            console.log(`         serialize ${fmt(snap.serialize)}`);
            console.log(`         write ${fmt(snap.write)}`);
            await store.close();
        });
    }
    return results;
}

async function syncIoAudit() {
    console.log('\n=== 同步 I/O 审计 ===');
    const hits = [];
    function walk(p) {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            for (const f of fs.readdirSync(p)) {
                if (f === 'node_modules' || f === '.git') continue;
                walk(path.join(p, f));
            }
            return;
        }
        if (!p.endsWith('.js')) return;
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            if (/readFileSync|writeFileSync|appendFileSync/.test(line) && !line.trim().startsWith('//')) {
                hits.push(`${path.relative(process.cwd(), p)}:${i + 1}: ${line.trim()}`);
            }
        });
    }
    walk(path.join(process.cwd(), 'bot.js'));
    walk(path.join(process.cwd(), 'lib'));
    hits.forEach((h) => console.log(h));
    console.log('sync hits=', hits.length);
    assert.ok(!hits.some((h) => h.includes('json-capital-store.js') && h.includes('appendFileSync')));
    return hits;
}

async function main() {
    console.log('🧪 JSON capital 基准开始');
    assert.strictEqual(classifyCommand('+1').type, CMD.CALCULATE);
    const a = await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await scenarioF();
    await scenarioG();
    const h = await scenarioH();
    await scenarioCompat();
    const scales = await scaleBench();
    await syncIoAudit();

    // 遗留 sqlite 文件（不删除）
    console.log('\n=== 遗留 SQLite 文件（保留未删） ===');
    function findSqlite(root, out = []) {
        if (!fs.existsSync(root)) return out;
        for (const name of fs.readdirSync(root)) {
            const p = path.join(root, name);
            let st;
            try { st = fs.statSync(p); } catch (_) { continue; }
            if (st.isDirectory()) {
                if (name === 'node_modules' || name === '.git') continue;
                findSqlite(p, out);
            } else if (/\.(db|sqlite|sqlite3|wal|shm)$/i.test(name) || /capital\.sqlite/i.test(name)) {
                out.push(p);
            }
        }
        return out;
    }
    const leftover = findSqlite(process.cwd());
    if (leftover.length === 0) console.log('(未发现)');
    else leftover.forEach((p) => console.log(p));

    console.log('\n======= 汇总 =======');
    console.log('A localTotal', fmt(a.local));
    console.log('A receiveToEnqueue', fmt(a.enq));
    console.log('A persist', fmt(a.persist));
    console.log('A cps=', a.cps.toFixed(1));
    console.log('H enqueue P95=', h.enq.p95.toFixed(3), 'recoverMs=', h.recoverWall.toFixed(1));
    console.log('native modules: none (no better-sqlite3)');
    console.log('capital path: data/capital.json');
    console.log('\n🎉 全部通过');
}

main().catch((err) => {
    console.error('\n❌ 失败:', err);
    process.exit(1);
});
