'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { LatencyRegistry } = require('./latency');

/**
 * capital.json 内存账本 + 单写者异步原子落盘
 * 兼容旧 schema：group.capital / history[] / statistics
 */
class JsonCapitalStore {
    constructor() {
        this.filePath = null;
        this.backupDir = null;
        this.currentState = null;
        this.currentRevision = 0;
        this.persistedRevision = 0;
        this.persistInFlight = false;
        this.dirty = false;
        this.persistenceFailed = false;
        this.revisionWaiters = [];
        this.messageIdIndex = new Set();
        this.getMaxHistory = () => 1000;
        this.isAutoBackupEnabled = () => true;
        this.getBackupIntervalHours = () => 24;
        this.now = () => Date.now();
        this.latency = new LatencyRegistry();
        this.mergeWaitMs = 3;
        this._flushTimer = null;
        this._mutex = Promise.resolve();
        this._lastBackupAt = null;
        this.readOnly = false;
        this.loadError = null;
    }

    configure({
        filePath,
        backupDir,
        getMaxHistory,
        isAutoBackupEnabled,
        getBackupIntervalHours,
        now,
        mergeWaitMs,
        latency
    } = {}) {
        if (filePath) this.filePath = filePath;
        if (backupDir) this.backupDir = backupDir;
        if (typeof getMaxHistory === 'function') this.getMaxHistory = getMaxHistory;
        if (typeof isAutoBackupEnabled === 'function') this.isAutoBackupEnabled = isAutoBackupEnabled;
        if (typeof getBackupIntervalHours === 'function') {
            this.getBackupIntervalHours = getBackupIntervalHours;
        }
        if (typeof now === 'function') this.now = now;
        if (mergeWaitMs != null) this.mergeWaitMs = mergeWaitMs;
        if (latency) this.latency = latency;
    }

    async load() {
        if (!this.filePath) throw new Error('JsonCapitalStore 未配置 filePath');
        const dir = path.dirname(this.filePath);
        await fsp.mkdir(dir, { recursive: true });
        if (this.backupDir) await fsp.mkdir(this.backupDir, { recursive: true });

        if (!fs.existsSync(this.filePath)) {
            this.currentState = { _description: '资金管理配置文件 2.0' };
            this.currentRevision = 0;
            this.persistedRevision = 0;
            this.dirty = true;
            await this.#flushNow();
            this.#rebuildMessageIndex();
            return this.currentState;
        }

        // 升级前备份（每天最多一份周期备份触发点）
        await this.#maybeBackup('startup');

        let raw;
        try {
            raw = await fsp.readFile(this.filePath, 'utf8');
        } catch (e) {
            this.loadError = e;
            this.readOnly = true;
            this.persistenceFailed = true;
            throw new Error(`读取 capital.json 失败: ${e.message}`);
        }

        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('capital.json 根节点必须是对象');
            }
            this.currentState = parsed;
            this.#rebuildMessageIndex();
            this.currentRevision = 0;
            this.persistedRevision = 0;
            this.dirty = false;
            this.persistenceFailed = false;
            this.readOnly = false;
            return this.currentState;
        } catch (e) {
            // 不得覆盖损坏文件；尝试备份
            const restored = await this.#tryRestoreBackup();
            if (restored) {
                this.currentState = restored;
                this.#rebuildMessageIndex();
                this.currentRevision = 0;
                this.persistedRevision = 0;
                this.dirty = false;
                this.persistenceFailed = false;
                this.readOnly = false;
                console.warn('⚠️ capital.json 损坏，已从备份恢复');
                return this.currentState;
            }
            this.loadError = e;
            this.readOnly = true;
            this.persistenceFailed = true;
            this.currentState = null;
            throw new Error(`capital.json 格式错误且无可用备份: ${e.message}`);
        }
    }

    #rebuildMessageIndex() {
        this.messageIdIndex = new Set();
        if (!this.currentState) return;
        for (const [key, group] of Object.entries(this.currentState)) {
            if (key.startsWith('_')) continue;
            if (!group || !Array.isArray(group.history)) continue;
            for (const rec of group.history) {
                if (rec && rec.messageId) this.messageIdIndex.add(rec.messageId);
            }
        }
    }

    async #tryRestoreBackup() {
        if (!this.backupDir || !fs.existsSync(this.backupDir)) return null;
        const files = (await fsp.readdir(this.backupDir))
            .filter((f) => f.startsWith('capital-') && f.endsWith('.json'))
            .sort()
            .reverse();
        for (const f of files) {
            try {
                const text = await fsp.readFile(path.join(this.backupDir, f), 'utf8');
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch (error) {
                console.warn(`⚠️ 忽略无效账本备份 ${f}: ${error.message}`);
            }
        }
        return null;
    }

    async #maybeBackup(reason) {
        if (!this.backupDir || !fs.existsSync(this.filePath)) return;
        if (!this.isAutoBackupEnabled()) return;

        const intervalHours = this.getBackupIntervalHours();
        if (!Number.isFinite(intervalHours) || intervalHours < 1) {
            throw new Error(`无效 backupInterval: ${intervalHours}`);
        }
        const now = this.now();
        if (this._lastBackupAt == null) this._lastBackupAt = await this.#findLatestBackupAt();
        if (this._lastBackupAt != null && now - this._lastBackupAt < intervalHours * 3600000) {
            return;
        }

        const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
        const dest = path.join(this.backupDir, `capital-${stamp}.json`);
        try {
            await fsp.copyFile(this.filePath, dest);
            this._lastBackupAt = now;
            await this.#pruneBackups();
            console.log(`✅ 已创建账本备份 (${reason}): ${dest}`);
        } catch (error) {
            console.warn('⚠️ 备份 capital.json 失败:', error.message);
        }
    }

    async #findLatestBackupAt() {
        if (!this.backupDir || !fs.existsSync(this.backupDir)) return null;
        const files = (await fsp.readdir(this.backupDir))
            .filter((file) => file.startsWith('capital-') && file.endsWith('.json'));
        let latest = null;
        for (const file of files) {
            const stat = await fsp.stat(path.join(this.backupDir, file));
            if (latest == null || stat.mtimeMs > latest) latest = stat.mtimeMs;
        }
        return latest;
    }

    async #pruneBackups() {
        if (!this.backupDir) return;
        const files = (await fsp.readdir(this.backupDir))
            .filter((f) => f.startsWith('capital-') && f.endsWith('.json'))
            .sort();
        while (files.length > 10) {
            const old = files.shift();
            await fsp.unlink(path.join(this.backupDir, old));
        }
    }

    #ensureGroup(groupId) {
        if (!this.currentState[groupId]) {
            this.currentState[groupId] = {
                capital: 0,
                history: [],
                statistics: {
                    totalOperations: 0,
                    lastOperation: null,
                    createdDate: new Date().toISOString()
                }
            };
        } else {
            const g = this.currentState[groupId];
            if (typeof g.capital !== 'number') g.capital = Number(g.capital) || 0;
            if (!Array.isArray(g.history)) g.history = [];
            if (!g.statistics || typeof g.statistics !== 'object') {
                g.statistics = {
                    totalOperations: g.history.length,
                    lastOperation: g.history[g.history.length - 1] || null,
                    createdDate: new Date().toISOString()
                };
            }
        }
        return this.currentState[groupId];
    }

    #runExclusive(fn) {
        const next = this._mutex.then(fn, fn);
        this._mutex = next.then(
            () => {},
            () => {}
        );
        return next;
    }

    hasMessageId(messageId) {
        if (!messageId) return false;
        return this.messageIdIndex.has(messageId);
    }

    /**
     * 与旧 CommandEngine 对齐的 mutate API
     */
    async mutate(msg) {
        if (this.persistenceFailed || this.readOnly) {
            return { ok: false, errorCode: 'PERSIST_FAILED', error: '数据存储故障，拒绝修改' };
        }
        if (!this.currentState) {
            return { ok: false, errorCode: 'NOT_LOADED', error: '账本未加载' };
        }

        const applied = await this.#runExclusive(() => this.#applyMutation(msg));
        if (!applied.ok) return applied;
        if (applied.duplicate) return applied;

        const rev = applied.revision;
        try {
            await this.persistAtLeast(rev);
        } catch (e) {
            return { ok: false, errorCode: 'PERSIST_FAILED', error: e.message || '保存失败' };
        }
        return applied;
    }

    #applyMutation(msg) {
        const messageId = msg.messageId || null;
        if (messageId && this.messageIdIndex.has(messageId)) {
            const g = this.#ensureGroup(msg.chatId);
            return {
                ok: true,
                duplicate: true,
                balanceBefore: g.capital,
                balanceAfter: g.capital,
                transactionId: null,
                revision: this.persistedRevision
            };
        }

        const group = this.#ensureGroup(msg.chatId);
        const balanceBefore = group.capital;
        let balanceAfter = balanceBefore;
        let amount = 0;
        let operation = msg.operation || '';
        let reversedId = null;
        const txId = crypto.randomUUID();
        const nowIso = new Date().toISOString();

        switch (msg.kind) {
            case 'delta': {
                balanceAfter = this.#applyCompute(balanceBefore, msg.operator, msg.value);
                amount = balanceAfter - balanceBefore;
                operation = msg.operation || `${msg.operator}${msg.value}`;
                break;
            }
            case 'set': {
                balanceAfter = Number(msg.newBalance);
                if (!Number.isFinite(balanceAfter)) {
                    return { ok: false, error: '无效余额' };
                }
                balanceAfter = Math.round(balanceAfter * 10000) / 10000;
                amount = balanceAfter - balanceBefore;
                operation = msg.operation || `set ${balanceAfter}`;
                break;
            }
            case 'clear': {
                balanceAfter = 0;
                amount = -balanceBefore;
                operation = msg.operation || '清账';
                group.history = [];
                group.statistics.totalOperations = 0;
                group.statistics.lastOperation = null;
                break;
            }
            case 'undo': {
                const hist = group.history;
                let lastIdx = -1;
                for (let i = hist.length - 1; i >= 0; i--) {
                    if (!hist[i].reversed) {
                        lastIdx = i;
                        break;
                    }
                }
                if (lastIdx < 0) {
                    return { ok: false, errorCode: 'NO_UNDO', error: '没有可撤回的操作', balanceBefore, balanceAfter };
                }
                const last = hist[lastIdx];
                balanceAfter = last.oldValue;
                amount = balanceAfter - balanceBefore;
                operation = msg.operation || `撤回操作: ${last.operation}`;
                reversedId = last.id;
                last.reversed = true;
                break;
            }
            default:
                return { ok: false, error: '未知操作' };
        }

        const record = {
            id: txId,
            timestamp: nowIso,
            operation,
            oldValue: balanceBefore,
            newValue: balanceAfter,
            change: amount,
            user: msg.senderId
                ? { name: msg.senderName || msg.senderId, id: msg.senderId }
                : null
        };
        if (messageId) record.messageId = messageId;
        if (reversedId) {
            record.reversedId = reversedId;
            record.reversed_transaction_id = reversedId;
        }

        if (msg.kind !== 'clear') {
            group.history.push(record);
            const maxRecords = this.getMaxHistory();
            if (group.history.length > maxRecords) {
                group.history = group.history.slice(-maxRecords);
            }
            group.statistics.totalOperations = (group.statistics.totalOperations || 0) + 1;
            group.statistics.lastOperation = record;
        } else {
            // 清账后也可留一条可选记录？旧实现清空 history 不留记录
        }

        group.capital = balanceAfter;
        if (messageId) this.messageIdIndex.add(messageId);

        this.currentRevision += 1;
        this.dirty = true;
        this.#scheduleFlush();

        return {
            ok: true,
            duplicate: false,
            balanceBefore,
            balanceAfter,
            transactionId: txId,
            amount,
            operation,
            revision: this.currentRevision
        };
    }

    #applyCompute(balance, operator, value) {
        let next;
        switch (operator) {
            case '+': next = balance + value; break;
            case '-': next = balance - value; break;
            case '*': next = balance * value; break;
            case '/':
                if (value === 0) throw Object.assign(new Error('除数不能为0'), { code: 'DIV_ZERO' });
                next = balance / value;
                break;
            default:
                throw Object.assign(new Error('未知运算符'), { code: 'BAD_OP' });
        }
        if (!Number.isFinite(next)) throw new Error('计算结果无效');
        return Math.round(next * 10000) / 10000;
    }

    async query(chatId, limit = 5) {
        if (!this.currentState) {
            return { ok: false, error: '账本未加载' };
        }
        if (this.persistenceFailed) {
            return {
                ok: false,
                errorCode: 'PERSIST_FAILED',
                error: '数据存储故障，余额不可信'
            };
        }
        const group = this.#ensureGroup(chatId);
        const lim = Math.min(Math.max(limit || 5, 1), 50);
        const history = group.history.slice(-lim);
        return {
            ok: true,
            balance: group.capital,
            version: this.currentRevision,
            history
        };
    }

    persistAtLeast(revision) {
        if (revision <= this.persistedRevision) return Promise.resolve(true);
        if (this.persistenceFailed) {
            return Promise.reject(new Error('数据存储故障'));
        }
        return new Promise((resolve, reject) => {
            this.revisionWaiters.push({ revision, resolve, reject });
            this.#scheduleFlush();
        });
    }

    #scheduleFlush() {
        if (this._flushTimer != null) return;
        const wait = Math.max(0, this.mergeWaitMs);
        if (wait === 0) {
            this._flushTimer = setImmediate(() => {
                this._flushTimer = null;
                this.#flushNow().catch((error) => {
                    console.error('❌ 延迟持久化失败:', error.message);
                });
            });
        } else {
            // 注意：不可 unref，否则 await persistAtLeast 时进程可能提前退出
            this._flushTimer = setTimeout(() => {
                this._flushTimer = null;
                this.#flushNow().catch((error) => {
                    console.error('❌ 延迟持久化失败:', error.message);
                });
            }, wait);
        }
    }

    async #flushNow() {
        if (this.persistInFlight) return;
        if (!this.dirty && this.persistedRevision >= this.currentRevision) {
            this.#resolveWaiters();
            return;
        }
        if (this.persistenceFailed) {
            this.#rejectWaiters(new Error('数据存储故障'));
            return;
        }

        this.persistInFlight = true;
        try {
            while (this.dirty || this.persistedRevision < this.currentRevision) {
                this.dirty = false;
                const targetRevision = this.currentRevision;
                // 浅层不可变快照：结构化克隆避免保存期间被继续改
                const snapStart = process.hrtime.bigint();
                const snapshot = this.#cloneState(this.currentState);
                const cloneMs = LatencyRegistry.nsToMs(snapStart);

                const serStart = process.hrtime.bigint();
                const payload = JSON.stringify(snapshot, null, 2);
                const jsonSerializeMs = LatencyRegistry.nsToMs(serStart);
                this.latency.record('jsonSerializeMs', jsonSerializeMs);
                this.latency.record('cloneMs', cloneMs);

                const writeStart = process.hrtime.bigint();
                await this.#maybeBackup('interval');
                await this.#atomicWrite(payload, targetRevision);
                const jsonWriteMs = LatencyRegistry.nsToMs(writeStart);
                this.latency.record('jsonWriteMs', jsonWriteMs);
                this.latency.record('persistMs', cloneMs + jsonSerializeMs + jsonWriteMs);

                this.persistedRevision = targetRevision;
                this.#resolveWaiters();

                if (!this.dirty && this.persistedRevision >= this.currentRevision) break;
            }
        } catch (e) {
            this.persistenceFailed = true;
            this.dirty = true;
            console.error('❌ capital.json 持久化失败:', e.message);
            this.#rejectWaiters(e);
        } finally {
            this.persistInFlight = false;
            if (this.dirty && !this.persistenceFailed) {
                this.#scheduleFlush();
            }
        }
    }

    #cloneState(state) {
        // 避免 JSON.parse(JSON.stringify) 在热路径双倍开销：用 structuredClone，失败再回退
        try {
            if (typeof structuredClone === 'function') return structuredClone(state);
        } catch (error) {
            console.warn('structuredClone 失败，改用 JSON 克隆:', error.message);
        }
        return JSON.parse(JSON.stringify(state));
    }

    async #atomicWrite(payload, revision) {
        const target = this.filePath;
        const tmp = path.join(
            path.dirname(target),
            `capital.json.tmp-${process.pid}-${revision}`
        );
        let fh;
        try {
            fh = await fsp.open(tmp, 'w');
            await fh.writeFile(payload, 'utf8');
            try {
                await fh.sync();
            } catch (error) {
                console.warn('账本临时文件无法执行 fsync:', error.message);
            }
            await fh.close();
            fh = null;

            try {
                await fsp.rename(tmp, target);
            } catch (err) {
                // Windows：目标存在时先替换
                await fsp.copyFile(tmp, target);
                await this.#unlinkIfExists(tmp);
            }
            await this.#cleanupTmpFiles();
        } catch (e) {
            if (fh) {
                try {
                    await fh.close();
                } catch (closeError) {
                    e.closeError = closeError;
                }
            }
            await this.#unlinkIfExists(tmp);
            throw e;
        }
    }

    async #cleanupTmpFiles() {
        const dir = path.dirname(this.filePath);
        try {
            const files = await fsp.readdir(dir);
            await Promise.all(
                files
                    .filter((f) => f.startsWith('capital.json.tmp-'))
                    .map((f) => this.#unlinkIfExists(path.join(dir, f)))
            );
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('清理账本临时文件失败:', error.message);
            }
        }
    }

    async #unlinkIfExists(filePath) {
        try {
            await fsp.unlink(filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    #resolveWaiters() {
        const kept = [];
        for (const w of this.revisionWaiters) {
            if (w.revision <= this.persistedRevision) w.resolve(true);
            else kept.push(w);
        }
        this.revisionWaiters = kept;
    }

    #rejectWaiters(err) {
        const list = this.revisionWaiters.splice(0, this.revisionWaiters.length);
        for (const w of list) w.reject(err);
    }

    getData() {
        return this.currentState;
    }

    getStatus() {
        return {
            currentRevision: this.currentRevision,
            persistedRevision: this.persistedRevision,
            dirty: this.dirty,
            persistInFlight: this.persistInFlight,
            persistenceFailed: this.persistenceFailed,
            readOnly: this.readOnly,
            waiterCount: this.revisionWaiters.length
        };
    }

    async flush() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        await this.#flushNow();
    }

    async close() {
        await this.flush();
    }
}

module.exports = { JsonCapitalStore };
