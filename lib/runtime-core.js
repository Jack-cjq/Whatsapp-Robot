'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const { classifyCommand, CMD, isSupportedBotCommand, isMathExpression } = require('./classify');
const { LatencyRegistry } = require('./latency');

/**
 * O(1) 内存去重（第一层）；最终幂等靠账本 history.messageId + 本去重
 */
class MessageDeduper {
    constructor({ ttlMs = 10 * 60 * 1000, maxSize = 20000 } = {}) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.map = new Map();
        this.duplicateCount = 0;
        this._cleanupCounter = 0;
    }

    /** @returns {boolean} true = 重复 */
    isDuplicate(messageId) {
        if (!messageId) return false;
        if ((++this._cleanupCounter & 1023) === 0) this.#cleanup();
        const exp = this.map.get(messageId);
        if (exp !== undefined) {
            if (exp > Date.now()) {
                this.duplicateCount++;
                return true;
            }
            this.map.delete(messageId);
        }
        this.map.set(messageId, Date.now() + this.ttlMs);
        if (this.map.size > this.maxSize) {
            const first = this.map.keys().next().value;
            this.map.delete(first);
        }
        return false;
    }

    #cleanup() {
        const now = Date.now();
        for (const [id, exp] of this.map) {
            if (exp <= now) this.map.delete(id);
        }
    }
}

/**
 * 联系人名称 LRU（不阻塞资金事务）
 */
class ContactNameCache {
    constructor({ maxSize = 2000, ttlMs = 30 * 60 * 1000 } = {}) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.map = new Map(); // id -> { name, exp }
    }

    get(senderId) {
        const row = this.map.get(senderId);
        if (!row) return null;
        if (row.exp < Date.now()) {
            this.map.delete(senderId);
            return null;
        }
        // LRU touch
        this.map.delete(senderId);
        this.map.set(senderId, row);
        return row.name;
    }

    set(senderId, name) {
        if (!senderId || !name) return;
        if (this.map.has(senderId)) this.map.delete(senderId);
        this.map.set(senderId, { name, exp: Date.now() + this.ttlMs });
        while (this.map.size > this.maxSize) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }
}

/**
 * 公平群调度：同群串行；异群并行；每完成一条将群放回队尾，避免饿死
 */
class FairGroupScheduler {
    constructor({ maxConcurrentGroups = 8, warnDepth = 500, hardLimit = 20000 } = {}) {
        this.maxConcurrentGroups = maxConcurrentGroups;
        this.warnDepth = warnDepth;
        this.hardLimit = hardLimit;
        this.queues = new Map();
        this.active = new Set();
        this.readyRing = [];
        this.readySet = new Set();
        this.processedCount = 0;
        this.failedCount = 0;
        this.droppedNonCommandCount = 0;
        this.overload = false;
        this.lastWarnAt = 0;
        this.latency = new LatencyRegistry();
    }

    get incomingQueueLength() {
        let n = 0;
        for (const q of this.queues.values()) n += q.length;
        return n;
    }

    get activeGroups() {
        return this.active.size;
    }

    getStatus() {
        return {
            incomingQueueLength: this.incomingQueueLength,
            activeGroups: this.activeGroups,
            queuedGroups: this.queues.size,
            processedCount: this.processedCount,
            failedCount: this.failedCount,
            droppedNonCommandCount: this.droppedNonCommandCount,
            overload: this.overload
        };
    }

    /**
     * @param {string} chatId
     * @param {object} item { run: Function, onError?: Function, enqueuedAtNs: bigint }
     * @returns {boolean} false = overload 拒绝（仅非资金场景；资金调用方应检查）
     */
    enqueue(chatId, item) {
        const depth = this.incomingQueueLength;
        if (depth >= this.hardLimit) {
            this.overload = true;
            return false;
        }
        if (depth >= this.warnDepth) {
            const now = Date.now();
            if (now - this.lastWarnAt > 5000) {
                this.lastWarnAt = now;
                console.warn(`⚠️ 业务队列告警 depth=${depth} groups=${this.queues.size}`);
            }
        }
        this.overload = false;

        let q = this.queues.get(chatId);
        if (!q) {
            q = [];
            this.queues.set(chatId, q);
        }
        q.push(item);
        this.#markReady(chatId);
        this.#pump();
        return true;
    }

    #markReady(chatId) {
        if (this.active.has(chatId)) return;
        if (this.readySet.has(chatId)) return;
        this.readySet.add(chatId);
        this.readyRing.push(chatId);
    }

    #pump() {
        while (this.active.size < this.maxConcurrentGroups && this.readyRing.length > 0) {
            const chatId = this.readyRing.shift();
            this.readySet.delete(chatId);
            const q = this.queues.get(chatId);
            if (!q || q.length === 0) {
                if (q && q.length === 0) this.queues.delete(chatId);
                continue;
            }
            if (this.active.has(chatId)) continue;
            this.#runOne(chatId);
        }
    }

    async #runOne(chatId) {
        this.active.add(chatId);
        const q = this.queues.get(chatId);
        const item = q && q.shift();
        if (!item) {
            this.active.delete(chatId);
            if (q && q.length === 0) this.queues.delete(chatId);
            this.#pump();
            return;
        }

        const startNs = process.hrtime.bigint();
        const queueWaitMs = LatencyRegistry.nsToMs(item.enqueuedAtNs, startNs);
        this.latency.record('queueWaitMs', queueWaitMs);

        try {
            await item.run({ queueWaitMs });
            this.processedCount++;
        } catch (err) {
            this.failedCount++;
            if (typeof item.onError === 'function') {
                try {
                    await item.onError(err);
                } catch (reportError) {
                    console.error('❌ 业务队列异常上报失败:', reportError);
                }
            } else {
                console.error('❌ 业务队列任务失败:', err);
            }
        } finally {
            if (q && q.length === 0) this.queues.delete(chatId);
            this.active.delete(chatId);
            if (q && q.length > 0) this.#markReady(chatId);
            this.#pump();
        }
    }
}

/**
 * 异步缓冲日志
 */
class AsyncLogger {
    constructor() {
        this.logDir = null;
        this.getMainWindow = () => null;
        this.isWindowVisible = () => true;
        this.buffer = [];
        this.maxBuffer = 5000;
        this.flushIntervalMs = 200;
        this.batchSize = 50;
        this.timer = null;
        this.stream = null;
        this.streamDate = null;
        this.pendingWrite = Promise.resolve();
        this.ipcBuffer = [];
        this.ipcIntervalMs = 500;
        this.ipcTimer = null;
        this.droppedLowPriority = 0;
        this.minConsoleLevel = process.env.BOT_LOG_LEVEL || 'WARN';
        this.levelRank = { ERROR: 0, WARN: 1, OPERATION: 2, SYSTEM: 2, INFO: 3, DEBUG: 4 };
        this.writable = true;
    }

    configure({ logDir, getMainWindow, isWindowVisible } = {}) {
        if (logDir) this.logDir = logDir;
        if (typeof getMainWindow === 'function') this.getMainWindow = getMainWindow;
        if (typeof isWindowVisible === 'function') this.isWindowVisible = isWindowVisible;
        this.#ensureTimer();
    }

    #ensureTimer() {
        if (!this.timer) {
            this.timer = setInterval(() => {
                this.flush().catch((error) => console.error('日志定时刷新失败:', error.message));
            }, this.flushIntervalMs);
            if (this.timer.unref) this.timer.unref();
        }
        if (!this.ipcTimer) {
            this.ipcTimer = setInterval(() => this.#flushIpc(), this.ipcIntervalMs);
            if (this.ipcTimer.unref) this.ipcTimer.unref();
        }
    }

    write(logData) {
        const type = logData.type || 'INFO';
        const entry = {
            timestamp: Date.now(),
            ...logData,
            type
        };

        if (this.buffer.length >= this.maxBuffer) {
            if (type === 'ERROR' || type === 'OPERATION' || type === 'WARN') {
                const idx = this.buffer.findIndex(e => e.type === 'DEBUG' || e.type === 'INFO');
                if (idx >= 0) {
                    this.buffer.splice(idx, 1);
                    this.droppedLowPriority++;
                }
            } else {
                this.droppedLowPriority++;
                return;
            }
        }

        this.buffer.push(entry);

        if (type === 'ERROR' || type === 'WARN') {
            const text = `${new Date(entry.timestamp).toISOString().slice(11, 19)} [${type}] ${entry.event || entry.action || entry.error || ''}`;
            this.ipcBuffer.push(text);
            if ((this.levelRank[type] ?? 3) <= (this.levelRank[this.minConsoleLevel] ?? 1)) {
                console.log(text);
            }
        } else if (type === 'OPERATION' || type === 'SYSTEM') {
            const text = `${new Date(entry.timestamp).toISOString().slice(11, 19)} [${type}] ${entry.event || entry.action || ''}`;
            this.ipcBuffer.push(text);
        }

        if (this.buffer.length >= this.batchSize) {
            this.flush().catch((error) => console.error('日志批量刷新失败:', error.message));
        }
    }

    system(event, details) { this.write({ type: 'SYSTEM', event, details }); }
    operation(groupId, action, user, capitalChange) {
        this.write({ type: 'OPERATION', groupId, action, user, ...capitalChange });
    }
    error(error, context) {
        this.write({
            type: 'ERROR',
            error: error && error.message ? error.message : String(error),
            stack: error && error.stack,
            context
        });
    }
    warn(message, context) { this.write({ type: 'WARN', event: message, context }); }
    info(event, details) { this.write({ type: 'INFO', event, details }); }
    debug(event, details) { this.write({ type: 'DEBUG', event, details }); }

    getQueueLength() { return this.buffer.length + this.ipcBuffer.length; }

    async flush() {
        if (!this.buffer.length || !this.logDir || !this.writable) {
            if (!this.writable && this.buffer.length) {
                // 保留 ERROR/OPERATION，丢弃低优先级以免内存涨
                this.buffer = this.buffer.filter(e => e.type === 'ERROR' || e.type === 'OPERATION' || e.type === 'WARN');
            }
            return;
        }
        const batch = this.buffer.splice(0, this.buffer.length);
        this.pendingWrite = this.pendingWrite.then(() => this.#writeBatch(batch));
        await this.pendingWrite;
    }

    async #writeBatch(batch) {
        try {
            await fsp.mkdir(this.logDir, { recursive: true });
            const date = new Date().toISOString().slice(0, 10);
            const logPath = path.join(this.logDir, `${date}.log`);
            if (!this.stream || this.streamDate !== date) {
                if (this.stream) await new Promise(r => this.stream.end(r));
                this.stream = fs.createWriteStream(logPath, { flags: 'a' });
                this.streamDate = date;
                this.stream.on('error', (err) => {
                    this.writable = false;
                    console.error('日志流错误:', err.message);
                });
            }
            const payload = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
            await new Promise((resolve) => {
                const ok = this.stream.write(payload, 'utf8');
                if (ok) return resolve();
                this.stream.once('drain', resolve);
            });
            this.writable = true;
        } catch (error) {
            this.writable = false;
            console.error('日志批量写入失败:', error.message);
            // 写回高优先级，避免资金审计丢失
            for (const e of batch) {
                if (e.type === 'ERROR' || e.type === 'OPERATION') this.buffer.push(e);
            }
        }
    }

    #flushIpc() {
        if (!this.ipcBuffer.length) return;
        if (!this.isWindowVisible()) {
            // 窗口隐藏时降低刷新：丢弃 INFO 级展示，保留少量
            if (this.ipcBuffer.length > 100) this.ipcBuffer = this.ipcBuffer.slice(-50);
            return;
        }
        const win = this.getMainWindow && this.getMainWindow();
        if (!win || (win.isDestroyed && win.isDestroyed())) {
            this.ipcBuffer.length = 0;
            return;
        }
        const lines = this.ipcBuffer.splice(0, Math.min(100, this.ipcBuffer.length));
        try {
            win.webContents.send('log-update-batch', lines);
        } catch (error) {
            console.warn('日志无法推送到界面:', error.message);
        }
    }

    async close() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.ipcTimer) { clearInterval(this.ipcTimer); this.ipcTimer = null; this.#flushIpc(); }
        await this.flush();
        if (this.stream) {
            await new Promise(r => this.stream.end(r));
            this.stream = null;
        }
    }
}

/**
 * 出站回复队列：事务成功后入队；不等待 WhatsApp resolve
 */
class OutboundMessageQueue {
    constructor({
        maxQueueSize = 2000,
        criticalMaxAgeMs = 30 * 60 * 1000,
        nonCriticalMaxAgeMs = 30 * 1000,
        processingDelay = 40
    } = {}) {
        this.maxQueueSize = maxQueueSize;
        this.criticalMaxAgeMs = criticalMaxAgeMs;
        this.nonCriticalMaxAgeMs = nonCriticalMaxAgeMs;
        this.processingDelay = processingDelay;
        this.queue = [];
        this.isProcessing = false;
        this.sendFn = null;
        this.isConnectedFn = () => true;
        this.onProcessed = () => {};
        this.onFailed = () => {};
        this.latency = new LatencyRegistry();
    }

    configure({ sendFn, isConnectedFn, onProcessed, onFailed } = {}) {
        if (sendFn) this.sendFn = sendFn;
        if (isConnectedFn) this.isConnectedFn = isConnectedFn;
        if (onProcessed) this.onProcessed = onProcessed;
        if (onFailed) this.onFailed = onFailed;
    }

    get length() { return this.queue.length; }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            isProcessing: this.isProcessing,
            sendingMessages: 0
        };
    }

    /**
     * 立即返回入队 Promise（queued_for_send），不等待网络发送完成。
     * 若 needWaitSend=true 则等待 sent/send_failed。
     */
    enqueue(chatId, message, options = {}) {
        const critical = options.critical !== false;
        const waitSend = options.waitSend === true;
        const enqueuedAtNs = process.hrtime.bigint();

        return new Promise((resolve, reject) => {
            if (this.queue.length >= this.maxQueueSize) {
                const dropIdx = this.queue.findIndex(i => !i.critical);
                if (dropIdx >= 0) {
                    const dropped = this.queue.splice(dropIdx, 1)[0];
                    dropped.resolve({ success: false, dropped: true, status: 'send_failed' });
                } else {
                    console.warn(`⚠️ 出站队列积压(全 critical) length=${this.queue.length}`);
                }
            }

            const item = {
                chatId,
                message,
                options: { sendSeen: false, ...options },
                critical,
                waitSend,
                timestamp: Date.now(),
                enqueuedAtNs,
                retries: 0,
                maxRetries: critical ? 8 : 3,
                resolve,
                reject,
                settledEnqueue: false
            };

            this.queue.push(item);

            // localTotal 截止点：已进入发送队列
            if (!waitSend) {
                item.settledEnqueue = true;
                resolve({ success: true, status: 'queued_for_send' });
            }

            this.#process().catch((error) => {
                console.error('❌ 出站队列处理失败:', error.message);
            });
        });
    }

    /** 兼容旧 API */
    sendMessage(chatId, message, options = {}) {
        return this.enqueue(chatId, message, options);
    }

    resume() {
        return this.#process();
    }

    async #process() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            const age = Date.now() - item.timestamp;
            const maxAge = item.critical ? this.criticalMaxAgeMs : this.nonCriticalMaxAgeMs;

            if (age > maxAge && !item.critical) {
                if (item.waitSend && !item.settledEnqueue) {
                    item.resolve({ success: false, status: 'send_failed', reason: 'expired' });
                }
                continue;
            }
            if (age > maxAge && item.critical) {
                item.timestamp = Date.now();
                this.queue.push(item);
                await this.#delay(100);
                continue;
            }

            try {
                if (!this.isConnectedFn()) {
                    this.queue.unshift(item);
                    break;
                }

                const callStart = process.hrtime.bigint();
                const result = await this.sendFn(item.chatId, item.message, item.options);
                const resolveMs = LatencyRegistry.nsToMs(callStart);
                this.latency.record('whatsappSendResolveMs', resolveMs);
                this.latency.record('whatsappSendCallMs', resolveMs);
                this.onProcessed();
                if (item.waitSend && !item.settledEnqueue) {
                    item.resolve({ success: true, status: 'sent', result });
                }
                await this.#delay(this.processingDelay);
            } catch (error) {
                this.onFailed();
                if (item.retries < item.maxRetries) {
                    item.retries++;
                    const backoff = Math.min(8000, 200 * Math.pow(2, item.retries));
                    await this.#delay(backoff);
                    this.queue.push(item);
                } else if (item.waitSend && !item.settledEnqueue) {
                    item.resolve({ success: false, status: 'send_failed', error: error.message });
                }
            }
        }

        this.isProcessing = false;
    }

    #delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    async drain(timeoutMs = 15000) {
        const start = Date.now();
        while ((this.queue.length > 0 || this.isProcessing) && Date.now() - start < timeoutMs) {
            await this.#process();
            await this.#delay(20);
        }
    }
}

class RuntimeMetrics {
    constructor() {
        this.histogram = null;
        this.timer = null;
        this.getSnapshot = () => ({});
        this.elu = null;
    }

    start(getSnapshot) {
        this.getSnapshot = getSnapshot;
        try {
            this.histogram = monitorEventLoopDelay({ resolution: 10 });
            this.histogram.enable();
        } catch (error) {
            this.histogram = null;
            console.warn('无法启用事件循环指标:', error.message);
        }
        try {
            const { performance } = require('perf_hooks');
            if (performance.eventLoopUtilization) {
                this.elu = performance.eventLoopUtilization();
            }
        } catch (error) {
            this.elu = null;
            console.warn('无法初始化事件循环利用率指标:', error.message);
        }
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.#tick(), 10000);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.histogram) {
            try {
                this.histogram.disable();
            } catch (error) {
                console.warn('无法关闭事件循环指标:', error.message);
            }
            this.histogram = null;
        }
    }

    #tick() {
        const snap = this.getSnapshot() || {};
        const h = this.histogram;
        const p50 = h ? Number((h.percentile(50) / 1e6).toFixed(2)) : -1;
        const p95 = h ? Number((h.percentile(95) / 1e6).toFixed(2)) : -1;
        const p99 = h ? Number((h.percentile(99) / 1e6).toFixed(2)) : -1;
        if (h) h.reset();
        let elu = null;
        try {
            if (this.elu && performance.eventLoopUtilization) {
                const next = performance.eventLoopUtilization(this.elu);
                elu = Number((next.utilization * 100).toFixed(1));
                this.elu = performance.eventLoopUtilization();
            }
        } catch (error) {
            this.elu = null;
            console.warn('无法采集事件循环利用率:', error.message);
        }
        const mem = process.memoryUsage();
        console.log(
            `📊 指标 | inQ=${snap.incomingQueueLength ?? 0} dbQ=${snap.dbQueueDepth ?? 0} ` +
            `outQ=${snap.outputQueueLength ?? 0} logQ=${snap.logQueueLength ?? 0} ` +
            `activeG=${snap.activeGroups ?? 0} ` +
            `loopP50=${p50} P95=${p95} P99=${p99} elu=${elu ?? '-'}% ` +
            `heapMB=${(mem.heapUsed / 1048576).toFixed(1)} rssMB=${(mem.rss / 1048576).toFixed(1)} ` +
            `ok=${snap.processedCount ?? 0} fail=${snap.failedCount ?? 0} dup=${snap.duplicateCount ?? 0}`
        );
    }
}

/**
 * 管理员 / 允许群 内存配置（原子替换）
 */
class MemoryAccessControl {
    constructor() {
        this.adminSet = new Set(); // 规范化后的 ID / 名称（小写）
        this.allowedGroups = null; // null = 不限制
        this.groupConfig = new Map();
        this.aliasMap = new Map();
    }

    replaceAdmins(ids) {
        const next = new Set();
        for (const id of ids || []) {
            for (const n of adminKeys(id)) next.add(n);
        }
        this.adminSet = next;
    }

    replaceAllowedGroups(ids) {
        if (!ids || ids.length === 0) {
            this.allowedGroups = null;
            return;
        }
        const next = new Set();
        for (const id of ids) next.add(String(id));
        this.allowedGroups = next;
    }

    /**
     * 同时匹配数字 ID（含 @lid）与显示名（如 AdminName / ~AdminName）
     */
    isAdmin(senderId, notifyName) {
        for (const key of adminKeys(senderId)) {
            if (this.adminSet.has(key)) return true;
        }
        for (const key of adminKeys(notifyName)) {
            if (this.adminSet.has(key)) return true;
        }
        return false;
    }

    isGroupAllowed(chatId) {
        if (!this.allowedGroups) return true;
        return this.allowedGroups.has(chatId);
    }
}

function normalizeId(id) {
    if (!id) return '';
    return String(id)
        .trim()
        .replace(/^~/, '')
        .replace(/@[^.]+\.us$/i, '')
        .replace(/@lid$/i, '');
}

/** 生成用于管理员匹配的键（原始规范化 + 小写名） */
function adminKeys(value) {
    const keys = [];
    if (value == null || value === '') return keys;
    const raw = String(value).trim();
    if (!raw) return keys;
    keys.push(raw);
    const norm = normalizeId(raw);
    if (norm) {
        keys.push(norm);
        keys.push(norm.toLowerCase());
    }
    // 去重
    return [...new Set(keys)];
}

module.exports = {
    classifyCommand,
    CMD,
    isSupportedBotCommand,
    isMathExpression,
    MessageDeduper,
    ContactNameCache,
    FairGroupScheduler,
    AsyncLogger,
    OutboundMessageQueue,
    RuntimeMetrics,
    MemoryAccessControl,
    LatencyRegistry,
    normalizeId,
    adminKeys
};
