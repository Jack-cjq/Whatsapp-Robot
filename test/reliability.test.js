'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const assert = require('assert');
const { ConfigFileStore, DEFAULT_CONFIG } = require('../lib/config-store');
const { JsonCapitalStore } = require('../lib/json-capital-store');
const {
    OutboundMessageQueue,
    FairGroupScheduler,
    MessageDeduper,
    LatencyRegistry
} = require('../lib/runtime-core');
const { prepareBrowserProfileDir } = require('../lib/browser-runtime');
const { createMessageIngressHandler, serializeMessageId } = require('../lib/message-ingress');
const {
    inspectWhatsappBridge,
    WhatsappBridgeWatchdog
} = require('../lib/whatsapp-bridge-health');

async function withTempDir(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-reliability-'));
    try {
        return await fn(dir);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

async function testConfigPatchPreservesHiddenFields() {
    await withTempDir(async (dir) => {
        const configPath = path.join(dir, 'config.json');
        const initial = {
            ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
            adminIds: ['admin-a'],
            allowedGroupIds: ['group-a@g.us'],
            maxConcurrentGroups: 12,
            customFeature: { enabled: true, mode: 'legacy' }
        };
        await fsp.writeFile(configPath, JSON.stringify(initial, null, 2), 'utf8');
        const store = new ConfigFileStore({ getFilePath: () => configPath });

        const fullConfig = store.getConfig();
        const saved = store.savePatch({ ...fullConfig, adminIds: ['admin-a', 'admin-a', ' admin-b '] });
        assert.deepStrictEqual(saved.adminIds, ['admin-a', 'admin-b']);
        assert.deepStrictEqual(saved.allowedGroupIds, ['group-a@g.us']);
        assert.strictEqual(saved.maxConcurrentGroups, 12);
        assert.deepStrictEqual(saved.customFeature, initial.customFeature);

        store.savePatch({ autoBackup: false, backupInterval: 48 });
        const disk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
        assert.deepStrictEqual(disk.allowedGroupIds, ['group-a@g.us']);
        assert.strictEqual(disk.maxConcurrentGroups, 12);
        assert.deepStrictEqual(disk.customFeature, initial.customFeature);
        assert.strictEqual(disk.autoBackup, false);
        assert.strictEqual(disk.backupInterval, 48);
    });
    console.log('✅ 配置部分更新保留隐藏字段');
}

async function testInvalidConfigPatchDoesNotOverwrite() {
    await withTempDir(async (dir) => {
        const configPath = path.join(dir, 'config.json');
        await fsp.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
        const store = new ConfigFileStore({ getFilePath: () => configPath });
        const before = await fsp.readFile(configPath, 'utf8');

        assert.throws(() => store.savePatch({ backupInterval: 0 }), /backupInterval/);
        assert.throws(() => store.savePatch({ unknownOption: true }), /不支持/);
        assert.throws(
            () => store.savePatch(JSON.parse('{"__proto__":{"polluted":true}}')),
            /禁止/
        );
        assert.strictEqual(await fsp.readFile(configPath, 'utf8'), before);
        assert.strictEqual({}.polluted, undefined);
    });
    console.log('✅ 无效配置不覆盖原文件');
}

async function testOutboundQueueResumesAfterReconnect() {
    let connected = false;
    const sent = [];
    const queue = new OutboundMessageQueue({ processingDelay: 0 });
    queue.configure({
        isConnectedFn: () => connected,
        sendFn: async (_chatId, message) => {
            sent.push(message);
            return { id: message };
        }
    });

    const pending = queue.enqueue('group-a', 'queued-during-disconnect', { waitSend: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(queue.length, 1);
    assert.deepStrictEqual(sent, []);

    connected = true;
    await queue.resume();
    const result = await pending;
    assert.strictEqual(result.status, 'sent');
    assert.deepStrictEqual(sent, ['queued-during-disconnect']);
    assert.strictEqual(queue.length, 0);
    console.log('✅ 重连后恢复发送队列');
}

async function testIncomingCommandRunsDuringConnectionRace() {
    const stats = { totalMessages: 0, processedMessages: 0, failedMessages: 0 };
    const scheduler = new FairGroupScheduler({ maxConcurrentGroups: 1 });
    const warnings = [];
    const errors = [];
    const infos = [];
    let handledDto;
    let markHandled;
    const handled = new Promise((resolve) => {
        markHandled = resolve;
    });
    const commandEngine = {
        handle: async (dto) => {
            handledDto = dto;
            markHandled();
            return { status: 'persisted_to_json' };
        }
    };
    const handler = createMessageIngressHandler({
        messageStats: stats,
        messageDeduper: new MessageDeduper(),
        groupCommandScheduler: scheduler,
        latencyRegistry: new LatencyRegistry(),
        logger: {
            warn: (...args) => warnings.push(args),
            error: (...args) => errors.push(args),
            info: (...args) => infos.push(args)
        },
        getRuntimeState: () => ({ isConnected: false, capitalReady: true, commandEngine })
    });
    const message = {
        fromMe: false,
        from: 'group-a@g.us',
        author: 'sender-a@lid',
        body: '+120/3',
        type: 'chat',
        timestamp: 1,
        _data: { notifyName: 'TestAdmin' },
        id: {
            fromMe: false,
            remote: 'group-a@g.us',
            participant: { _serialized: 'sender-a@lid' },
            id: 'ABC123'
        }
    };

    assert.strictEqual(
        serializeMessageId(message),
        'in|group-a@g.us|sender-a@lid|ABC123'
    );
    handler(message);
    await handled;
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(stats.totalMessages, 1);
    assert.strictEqual(stats.failedMessages, 0);
    assert.strictEqual(handledDto.messageId, 'in|group-a@g.us|sender-a@lid|ABC123');
    assert.strictEqual(handledDto.notifyName, 'TestAdmin');
    assert.strictEqual(scheduler.processedCount, 1);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(
        infos.map((entry) => entry[0]),
        ['COMMAND_RECEIVED', 'COMMAND_RESULT']
    );
    console.log('✅ 连接状态竞态不再丢弃已收到的记账命令');
}

async function testSchedulerReportsTaskFailures() {
    const scheduler = new FairGroupScheduler({ maxConcurrentGroups: 1 });
    let reportFailure;
    const reported = new Promise((resolve) => {
        reportFailure = resolve;
    });
    scheduler.enqueue('group-a@g.us', {
        enqueuedAtNs: process.hrtime.bigint(),
        run: async () => {
            throw new Error('expected scheduler failure');
        },
        onError: (error) => reportFailure(error)
    });

    const error = await reported;
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(error.message, /expected scheduler failure/);
    assert.strictEqual(scheduler.failedCount, 1);
    assert.strictEqual(scheduler.activeGroups, 0);
    console.log('✅ 调度任务异常会被上报且不会卡住群队列');
}

async function testBridgeWatchdogDetectsLostInjection() {
    const healthyState = {
        hasWWebJS: true,
        hasMessageBridge: true,
        socketState: 'CONNECTED'
    };
    const healthyClient = {
        pupPage: {
            isClosed: () => false,
            evaluate: async () => healthyState
        }
    };
    assert.deepStrictEqual(await inspectWhatsappBridge(healthyClient), healthyState);

    const brokenClient = {
        pupPage: {
            isClosed: () => false,
            evaluate: async () => ({
                hasWWebJS: false,
                hasMessageBridge: false,
                socketState: 'CONNECTED'
            })
        }
    };
    await assert.rejects(
        () => inspectWhatsappBridge(brokenClient),
        (error) => error.code === 'WA_MESSAGE_BRIDGE_LOST'
    );

    let reportUnhealthy;
    const unhealthy = new Promise((resolve) => {
        reportUnhealthy = resolve;
    });
    const watchdog = new WhatsappBridgeWatchdog({ intervalMs: 1000 });
    watchdog.start({
        getClient: () => brokenClient,
        isConnected: () => true,
        onHealthy: () => {
            throw new Error('broken bridge must not be marked healthy');
        },
        onUnhealthy: (error) => reportUnhealthy(error)
    });
    const reported = await unhealthy;
    watchdog.stop();
    assert.strictEqual(reported.code, 'WA_MESSAGE_BRIDGE_LOST');
    console.log('✅ 消息桥接丢失会被健康检查发现并触发重连');
}

async function testBackupSettingsAreApplied() {
    await withTempDir(async (dir) => {
        const disabledRoot = path.join(dir, 'disabled');
        const disabledFile = path.join(disabledRoot, 'capital.json');
        const disabledBackups = path.join(disabledRoot, 'backups');
        await fsp.mkdir(disabledBackups, { recursive: true });
        await fsp.writeFile(disabledFile, JSON.stringify({ _description: 'test' }), 'utf8');
        const disabledStore = new JsonCapitalStore();
        disabledStore.configure({
            filePath: disabledFile,
            backupDir: disabledBackups,
            isAutoBackupEnabled: () => false,
            getBackupIntervalHours: () => 1
        });
        await disabledStore.load();
        assert.deepStrictEqual(await fsp.readdir(disabledBackups), []);

        const enabledRoot = path.join(dir, 'enabled');
        const enabledFile = path.join(enabledRoot, 'capital.json');
        const enabledBackups = path.join(enabledRoot, 'backups');
        await fsp.mkdir(enabledBackups, { recursive: true });
        await fsp.writeFile(
            enabledFile,
            JSON.stringify({ groupA: { capital: 5, history: [], statistics: {} } }),
            'utf8'
        );
        let now = Date.now();
        const enabledStore = new JsonCapitalStore();
        enabledStore.configure({
            filePath: enabledFile,
            backupDir: enabledBackups,
            isAutoBackupEnabled: () => true,
            getBackupIntervalHours: () => 1,
            now: () => now,
            mergeWaitMs: 0
        });
        await enabledStore.load();
        assert.strictEqual((await fsp.readdir(enabledBackups)).length, 1);

        now += 2 * 3600000;
        const changed = await enabledStore.mutate({
            kind: 'delta',
            messageId: 'backup-test-1',
            chatId: 'groupA',
            operator: '+',
            value: 1,
            senderId: 'test'
        });
        assert.strictEqual(changed.ok, true);
        assert.strictEqual((await fsp.readdir(enabledBackups)).length, 2);
    });
    console.log('✅ 自动备份开关和间隔生效');
}

async function testRendererAvoidsDynamicHtmlInjection() {
    const renderer = await fsp.readFile(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(renderer), 'renderer.js 不得对动态数据使用 innerHTML');
    assert.ok(!/insertAdjacentHTML/.test(renderer), 'renderer.js 不得插入动态 HTML');
    assert.match(renderer, /let uptimeTimer = null;/, '运行时间必须只有一个定时器');
    assert.match(renderer, /if \(uptimeTimer\) return;/, '重复刷新仪表板不得重复创建计时器');
    assert.ok(!/function updateUptime\(\)[\s\S]{0,160}let seconds = 0;/.test(renderer));
    console.log('✅ 渲染层动态内容使用 textContent/DOM API');
}

async function testBrowserProfileCleanupIsScoped() {
    await withTempDir(async (dir) => {
        const sessionDir = path.join(dir, 'session-whatsapp-bot-v2');
        await fsp.mkdir(sessionDir, { recursive: true });
        await fsp.writeFile(path.join(sessionDir, 'lockfile'), 'stale');
        await fsp.writeFile(path.join(sessionDir, 'keep-me'), 'safe');
        prepareBrowserProfileDir(dir);
        assert.strictEqual(fs.existsSync(path.join(sessionDir, 'lockfile')), false);
        assert.strictEqual(fs.existsSync(path.join(sessionDir, 'keep-me')), true);
    });
    console.log('✅ 浏览器锁清理范围受控');
}

async function main() {
    console.log('🧪 可靠性与安全测试开始');
    await testConfigPatchPreservesHiddenFields();
    await testInvalidConfigPatchDoesNotOverwrite();
    await testOutboundQueueResumesAfterReconnect();
    await testIncomingCommandRunsDuringConnectionRace();
    await testSchedulerReportsTaskFailures();
    await testBridgeWatchdogDetectsLostInjection();
    await testBackupSettingsAreApplied();
    await testRendererAvoidsDynamicHtmlInjection();
    await testBrowserProfileCleanupIsScoped();
    console.log('🎉 可靠性与安全测试全部通过');
}

main().catch((error) => {
    console.error('❌ 可靠性与安全测试失败:', error);
    process.exit(1);
});
