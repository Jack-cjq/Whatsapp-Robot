'use strict';

const math = require('mathjs');
const { CMD } = require('./classify');
const { LatencyRegistry, normalizeId } = require('./runtime-core');

/**
 * 资金命令引擎：内存修改 → 等待 capital.json 落盘 → 再入发送队列
 * localTotalMs = receive → persisted_to_json → queued_for_send
 */
class CommandEngine {
    constructor({
        capitalStore,
        accessControl,
        outbound,
        logger,
        contactCache,
        latency,
        mathValidator
    }) {
        this.capitalStore = capitalStore;
        this.accessControl = accessControl;
        this.outbound = outbound;
        this.logger = logger;
        this.contactCache = contactCache;
        this.latency = latency || new LatencyRegistry();
        this.mathValidator = mathValidator;
    }

    async handle(dto, classified) {
        const authStart = process.hrtime.bigint();
        const senderNorm = normalizeId(dto.senderId);

        if (!this.accessControl.isGroupAllowed(dto.chatId)) {
            return { status: 'ignored_group' };
        }
        const notifyName = dto.notifyName || '';
        if (!this.accessControl.isAdmin(dto.senderId, notifyName)) {
            this.latency.record('parseAndAuthorizeMs', LatencyRegistry.nsToMs(authStart));
            this.logger.warn('UNAUTHORIZED_COMMAND', {
                senderId: senderNorm,
                notifyName: notifyName || undefined,
                chatId: dto.chatId
            });
            return { status: 'unauthorized' };
        }
        this.latency.record('parseAndAuthorizeMs', LatencyRegistry.nsToMs(authStart));

        if (notifyName) this.contactCache.set(dto.senderId, notifyName);
        const displayName = notifyName || this.contactCache.get(dto.senderId) || senderNorm || 'admin';
        const txStart = process.hrtime.bigint();
        let txResult;
        let replyText;
        let critical = true;

        try {
            if (this.capitalStore.persistenceFailed || this.capitalStore.readOnly) {
                throw new Error('数据存储故障，拒绝记账');
            }

            switch (classified.type) {
                case CMD.QUERY: {
                    txResult = await this.capitalStore.query(dto.chatId, 5);
                    this.latency.record('transactionMs', LatencyRegistry.nsToMs(txStart));
                    if (!txResult.ok) throw new Error(txResult.error || 'query failed');
                    replyText = this.#formatQuery(txResult);
                    break;
                }

                case CMD.HELP:
                    critical = false;
                    replyText = this.#helpText();
                    this.latency.record('transactionMs', 0);
                    txResult = { ok: true };
                    break;

                case CMD.CLEAR: {
                    txResult = await this.capitalStore.mutate({
                        kind: 'clear',
                        messageId: dto.messageId,
                        chatId: dto.chatId,
                        senderId: dto.senderId,
                        senderName: displayName,
                        operation: '清账'
                    });
                    this.latency.record('transactionMs', LatencyRegistry.nsToMs(txStart));
                    if (!txResult.ok) throw new Error(txResult.error || 'clear failed');
                    replyText = txResult.duplicate
                        ? `⚠️ 重复消息已忽略\n当前余额: ${txResult.balanceAfter}`
                        : '🔄 清账成功\n当前余额: 0\n历史记录已全部清除';
                    if (!txResult.duplicate) {
                        this.logger.operation(dto.chatId, 'CLEAR', { id: senderNorm, name: displayName }, {
                            before: txResult.balanceBefore,
                            after: 0
                        });
                    }
                    break;
                }

                case CMD.UNDO: {
                    txResult = await this.capitalStore.mutate({
                        kind: 'undo',
                        messageId: dto.messageId,
                        chatId: dto.chatId,
                        senderId: dto.senderId,
                        senderName: displayName,
                        operation: '撤回'
                    });
                    this.latency.record('transactionMs', LatencyRegistry.nsToMs(txStart));
                    if (!txResult.ok) {
                        replyText = `❌ ${txResult.error || '撤回失败'}`;
                        break;
                    }
                    if (txResult.duplicate) {
                        replyText = `⚠️ 重复消息已忽略\n当前余额: ${txResult.balanceAfter}`;
                    } else {
                        replyText =
                            `↩️ 撤回成功\n` +
                            `撤回操作: ${txResult.operation}\n` +
                            `撤回前余额: ${txResult.balanceBefore}\n` +
                            `撤回后余额: ${txResult.balanceAfter}`;
                        this.logger.operation(dto.chatId, 'REVOKE', { id: senderNorm, name: displayName }, {
                            before: txResult.balanceBefore,
                            after: txResult.balanceAfter
                        });
                    }
                    break;
                }

                case CMD.CALCULATE: {
                    txResult = await this.#calculate(dto, classified, displayName);
                    this.latency.record('transactionMs', LatencyRegistry.nsToMs(txStart));
                    if (!txResult.ok) throw new Error(txResult.error || 'calculate failed');
                    if (txResult.duplicate) {
                        replyText = `⚠️ 重复消息已忽略\n当前余额: ${txResult.balanceAfter}`;
                    } else {
                        const change = Math.round(
                            (txResult.balanceAfter - txResult.balanceBefore) * 10000
                        ) / 10000;
                        const formula = txResult.formula || classified.trimmed;
                        replyText =
                            `🔢 计算成功\n` +
                            `当前余额: ${txResult.balanceAfter}\n` +
                            `原值: ${txResult.balanceBefore}\n` +
                            `算式: ${formula}\n` +
                            `新值: ${txResult.balanceAfter}\n` +
                            `变化: ${change >= 0 ? '+' : ''}${change}` +
                            (classified.comment ? `\n备注: ${classified.comment}` : '');
                        this.logger.operation(dto.chatId, 'CALCULATION', { id: senderNorm, name: displayName }, {
                            before: txResult.balanceBefore,
                            after: txResult.balanceAfter
                        });
                    }
                    break;
                }

                default:
                    return { status: 'ignore' };
            }
        } catch (error) {
            this.latency.record('transactionMs', LatencyRegistry.nsToMs(txStart));
            this.logger.error(error, { context: 'command_engine', chatId: dto.chatId });
            // 未持久化成功：不得说修改成功
            replyText = `❌ 操作失败: ${error.message}`;
            critical = true;
            const sendStart = process.hrtime.bigint();
            await this.outbound.enqueue(dto.chatId, replyText, { critical });
            this.latency.record('commitToSendQueueMs', LatencyRegistry.nsToMs(sendStart));
            return { status: 'persist_error', error: error.message };
        }

        if (!replyText) return { status: 'no_reply' };

        // persisted_to_json 已在 mutate 内 await；此处进入 queued_for_send
        const sendStart = process.hrtime.bigint();
        const queued = await this.outbound.enqueue(dto.chatId, replyText, { critical });
        this.latency.record('commitToSendQueueMs', LatencyRegistry.nsToMs(sendStart));

        return {
            status: 'persisted_to_json',
            sendStatus: queued.status,
            balanceAfter: txResult && txResult.balanceAfter
        };
    }

    async #calculate(dto, classified, displayName) {
        if (classified.operator && classified.value != null && !classified.complex) {
            const q = await this.capitalStore.query(dto.chatId, 1);
            if (!q.ok) return q;
            const formula = `(${q.balance})${classified.operator}(${classified.value})`;
            const result = await this.capitalStore.mutate({
                kind: 'delta',
                messageId: dto.messageId,
                chatId: dto.chatId,
                senderId: dto.senderId,
                senderName: displayName,
                operator: classified.operator,
                value: classified.value,
                operation: classified.comment
                    ? `${classified.operator}${classified.value} (${classified.comment})`
                    : `${classified.operator}${classified.value}`
            });
            if (result && result.ok) result.formula = formula;
            return result;
        }

        const q = await this.capitalStore.query(dto.chatId, 1);
        if (!q.ok) return q;
        const current = q.balance;
        const expr = classified.expression || classified.trimmed;
        const full = `(${current})${String(expr).replace(/\s/g, '')}`;
        let result;
        try {
            if (this.mathValidator) {
                result = this.mathValidator.safeEvaluate(full);
            } else {
                result = math.evaluate(full.replace(/×/g, '*').replace(/÷/g, '/'));
                result = parseFloat(Number(result).toFixed(4));
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }

        const mutated = await this.capitalStore.mutate({
            kind: 'set',
            messageId: dto.messageId,
            chatId: dto.chatId,
            senderId: dto.senderId,
            senderName: displayName,
            newBalance: result,
            operation: classified.comment
                ? `计算: ${expr} = ${result} (${classified.comment})`
                : `计算: ${expr} = ${result}`
        });
        if (mutated && mutated.ok) mutated.formula = full;
        return mutated;
    }

    #formatQuery(txResult) {
        let message = `💰 当前余额: ${txResult.balance}\n\n`;
        const history = txResult.history || [];
        if (history.length > 0) {
            message += '📜 最近操作:\n';
            history.forEach((record, index) => {
                const ts = record.timestamp || record.created_at;
                const time = ts
                    ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ')
                    : '';
                const changeVal = record.change != null ? record.change : record.amount;
                const change = changeVal >= 0 ? `+${changeVal}` : `${changeVal}`;
                const oldV = record.oldValue != null ? record.oldValue : record.balance_before;
                const newV = record.newValue != null ? record.newValue : record.balance_after;
                message += `${index + 1}. ${time} ${record.operation}\n`;
                message += `   原值: ${oldV} → 新值: ${newV} (${change})\n`;
            });
        } else {
            message += '📝 暂无操作记录';
        }
        return message;
    }

    #helpText() {
        return (
            `🤖 WhatsApp资金管理机器人 2.0 帮助\n\n` +
            `📋 可用命令:\n` +
            `• /查账 或 查账 - 查看当前余额和最近操作\n` +
            `• /清账 或 清账 - 清空所有数据和历史记录\n` +
            `• /撤回 或 撤回 - 撤回最近一次操作\n` +
            `• /帮助 或 帮助 - 显示此帮助信息\n\n` +
            `🔢 数学计算:\n` +
            `• 简单计算: +100, -50, *2, /3\n` +
            `• 带注释计算: +100#预付款\n` +
            `• 复合表达式: +1+2*3`
        );
    }
}

module.exports = { CommandEngine };
