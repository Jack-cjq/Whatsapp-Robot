'use strict';

/**
 * 最小可执行并发/落盘/去重/日志测试（不依赖 Electron / WhatsApp）
 * 运行: npm test
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const assert = require('assert');
const {
    isSupportedBotCommand,
    MessageDeduper,
    GroupCommandScheduler,
    CapitalStore,
    AsyncLogger,
    OutboundMessageQueue
} = require('../lib/runtime-core');

async function withTempDir(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-bot-test-'));
    try {
        await fn(dir);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function testCommandFilter() {
    assert.strictEqual(isSupportedBotCommand('+1'), true);
    assert.strictEqual(isSupportedBotCommand('-20'), true);
    assert.strictEqual(isSupportedBotCommand('*2'), true);
    assert.strictEqual(isSupportedBotCommand('/查账'), true);
    assert.strictEqual(isSupportedBotCommand('查账'), true);
    assert.strictEqual(isSupportedBotCommand('+1+2*3'), true);
    assert.strictEqual(isSupportedBotCommand('你好'), false);
    assert.strictEqual(isSupportedBotCommand('打开此链接'), false);
    console.log('✅ 命令过滤');
}

async function testDeduper() {
    const d = new MessageDeduper({ ttlMs: 60000, maxSize: 100 });
    assert.strictEqual(d.isDuplicate('a'), false);
    assert.strictEqual(d.isDuplicate('a'), true);
    assert.strictEqual(d.isDuplicate('b'), false);
    assert.strictEqual(d.duplicateCount, 1);
    console.log('✅ 消息去重');
}

async function testGroupSerialOrder() {
    const scheduler = new GroupCommandScheduler({ maxConcurrentGroups: 4 });
    const order = [];
    const tasks = [];
    for (let i = 0; i < 20; i++) {
        tasks.push(new Promise(resolve => {
            scheduler.enqueue('g1', async () => {
                await sleep(5);
                order.push(i);
                resolve();
            });
        }));
    }
    await Promise.all(tasks);
    assert.deepStrictEqual(order, [...Array(20).keys()]);
    console.log('✅ 同群串行顺序');
}

async function testTwoGroupsIndependent() {
    const scheduler = new GroupCommandScheduler({ maxConcurrentGroups: 4 });
    const a = [];
    const b = [];
    const waits = [];
    for (let i = 0; i < 50; i++) {
        waits.push(new Promise(r => scheduler.enqueue('ga', async () => { a.push(1); r(); })));
        waits.push(new Promise(r => scheduler.enqueue('gb', async () => { b.push(1); r(); })));
    }
    await Promise.all(waits);
    assert.strictEqual(a.length, 50);
    assert.strictEqual(b.length, 50);
    console.log('✅ 两群互不影响');
}

async function testCapitalConcurrentSameGroup() {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'capital.json');
        const store = new CapitalStore();
        store.configure({ filePath: file, getMaxHistory: () => 1000 });
        store.loadSync();

        const scheduler = new GroupCommandScheduler({ maxConcurrentGroups: 1 });
        const waits = [];
        for (let i = 0; i < 100; i++) {
            waits.push(new Promise((resolve, reject) => {
                scheduler.enqueue('groupA', async () => {
                    try {
                        const cur = store.getCapital('groupA').capital;
                        await store.updateCapital('groupA', cur + 1, `+1 #${i}`, { name: 't', id: '1' });
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            }));
        }
        await Promise.all(waits);
        assert.strictEqual(store.getCapital('groupA').capital, 100);

        // 混合 +100 -20 撤回语义：顺序执行
        await new Promise((resolve, reject) => {
            scheduler.enqueue('groupA', async () => {
                try {
                    let cur = store.getCapital('groupA').capital;
                    await store.updateCapital('groupA', cur + 100, '+100', { name: 't', id: '1' });
                    cur = store.getCapital('groupA').capital;
                    await store.updateCapital('groupA', cur - 20, '-20', { name: 't', id: '1' });
                    const hist = store.getHistory('groupA', 2);
                    const prev = hist.length >= 2 ? hist[hist.length - 2].newValue : 0;
                    await store.updateCapital('groupA', prev, '撤回', { name: 't', id: '1' });
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        // 100 +100 = 200; -20 = 180; 撤回到 -20 前 = 200
        assert.strictEqual(store.getCapital('groupA').capital, 200);

        const disk = JSON.parse(await fsp.readFile(file, 'utf8'));
        assert.strictEqual(disk.groupA.capital, 200);
        console.log('✅ 同群 100 次 +1 与混合撤回');
    });
}

async function testTwoGroupsCapital() {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'capital.json');
        const store = new CapitalStore();
        store.configure({ filePath: file });
        store.loadSync();
        const scheduler = new GroupCommandScheduler({ maxConcurrentGroups: 4 });
        const waits = [];
        for (let i = 0; i < 100; i++) {
            waits.push(new Promise((resolve, reject) => {
                scheduler.enqueue('g1', async () => {
                    try {
                        const cur = store.getCapital('g1').capital;
                        await store.updateCapital('g1', cur + 1, '+1');
                        resolve();
                    } catch (e) { reject(e); }
                });
            }));
            waits.push(new Promise((resolve, reject) => {
                scheduler.enqueue('g2', async () => {
                    try {
                        const cur = store.getCapital('g2').capital;
                        await store.updateCapital('g2', cur + 2, '+2');
                        resolve();
                    } catch (e) { reject(e); }
                });
            }));
        }
        await Promise.all(waits);
        assert.strictEqual(store.getCapital('g1').capital, 100);
        assert.strictEqual(store.getCapital('g2').capital, 200);
        console.log('✅ 两群各 100 次操作');
    });
}

async function testLoggerNoCrashAndBatch() {
    await withTempDir(async (dir) => {
        const logger = new AsyncLogger();
        let ipcBatches = 0;
        let ipcLines = 0;
        const fakeWin = {
            isDestroyed: () => false,
            webContents: {
                send: (channel, lines) => {
                    if (channel === 'log-update-batch') {
                        ipcBatches++;
                        ipcLines += lines.length;
                    }
                }
            }
        };
        logger.configure({ logDir: dir, getMainWindow: () => fakeWin });

        for (let i = 0; i < 120; i++) {
            logger.info('CHAT', { i });
            logger.operation('g', 'CALC', { id: '1' }, { before: i, after: i + 1 });
        }
        // 伪造写失败路径：关闭 stream 目录权限很难，改为 flush 后 close
        await logger.flush();
        await sleep(600); // 等待 IPC 批量窗口
        await logger.close();

        assert.ok(ipcBatches >= 1, '应至少批量 IPC 一次');
        assert.ok(ipcLines >= 1);
        // 不应为每条 OPERATION 单独 IPC（120 次操作不应产生 240 次 IPC）
        assert.ok(ipcBatches < 50, `IPC 批次过多: ${ipcBatches}`);

        const files = await fsp.readdir(dir);
        assert.ok(files.some(f => f.endsWith('.log')));
        console.log('✅ 日志缓冲与批量 IPC');
    });
}

async function testOutboundCriticalNotDropped() {
    const sent = [];
    const q = new OutboundMessageQueue({ maxQueueSize: 5, nonCriticalMaxAgeMs: 1, criticalMaxAgeMs: 60000 });
    q.configure({
        sendFn: async (chatId, message) => {
            await sleep(20);
            sent.push(message);
            return { id: message };
        },
        isConnectedFn: () => true
    });

    // 塞满 nonCritical，再塞 critical
    const waits = [];
    for (let i = 0; i < 20; i++) {
        waits.push(q.sendMessage('c1', `help-${i}`, { critical: false }));
    }
    waits.push(q.sendMessage('c1', 'BALANCE_RESULT', { critical: true }));
    const results = await Promise.all(waits);
    assert.ok(sent.includes('BALANCE_RESULT'), 'critical 回复必须发出');
    const criticalResult = results[results.length - 1];
    assert.strictEqual(criticalResult.success, true);
    console.log('✅ critical 回复不被静默丢弃');
}

async function testAtomicWriteKeepsOriginalOnFailure() {
    await withTempDir(async (dir) => {
        const file = path.join(dir, 'capital.json');
        fs.writeFileSync(file, JSON.stringify({ g: { capital: 7, history: [], statistics: { totalOperations: 0 } } }, null, 2));
        const store = new CapitalStore();
        store.configure({ filePath: file });
        store.loadSync();
        assert.strictEqual(store.getCapital('g').capital, 7);

        // 指向不存在目录，触发落盘失败；原文件应保持不变
        store.filePath = path.join(dir, 'missing-subdir', 'capital.json');
        store.cache.g.capital = 99;
        store.dirty = true;
        const ok = await store.persist();
        assert.strictEqual(ok, false);

        const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(disk.g.capital, 7, '原文件不应被损坏');
        console.log('✅ 落盘失败时原文件完好');
    });
}

async function main() {
    console.log('🧪 开始并发与落盘测试...\n');
    await testCommandFilter();
    await testDeduper();
    await testGroupSerialOrder();
    await testTwoGroupsIndependent();
    await testCapitalConcurrentSameGroup();
    await testTwoGroupsCapital();
    await testLoggerNoCrashAndBatch();
    await testOutboundCriticalNotDropped();
    await testAtomicWriteKeepsOriginalOnFailure();
    console.log('\n🎉 全部测试通过');
}

main().catch((err) => {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
});
