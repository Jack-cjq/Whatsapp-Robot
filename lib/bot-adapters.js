'use strict';

const math = require('mathjs');
const { classifyCommand, CMD } = require('./classify');
const { isMathExpression, normalizeId } = require('./runtime-core');

function createBotAdapters({
    asyncLogger,
    capitalStore,
    outboundQueue,
    getMessageStats,
    getConfig,
    accessControl,
    getCommandEngine
}) {
    class Logger {
        static write(data) { asyncLogger.write(data); }
        static system(event, data) { asyncLogger.system(event, data); }
        static operation(groupId, action, user, context) {
            asyncLogger.operation(groupId, action, user, context);
        }
        static error(error, context) { asyncLogger.error(error, context); }
        static warn(message, context) { asyncLogger.warn(message, context); }
        static info(event, data) { asyncLogger.info(event, data); }
        static debug(event, data) { asyncLogger.debug(event, data); }
        static async flush() { return asyncLogger.flush(); }
    }

    class CapitalManager {
        static async getCapital(groupId) {
            const result = await capitalStore.query(groupId, 1);
            return {
                capital: result.balance || 0,
                history: result.history || [],
                statistics: { totalOperations: (result.history || []).length }
            };
        }

        static async getHistory(groupId, limit = 10) {
            const result = await capitalStore.query(groupId, limit);
            return result.history || [];
        }

        static getData() {
            return capitalStore.getData() || { _description: '资金管理配置文件 2.0' };
        }

        static async flush() {
            return capitalStore.flush();
        }
    }

    class MessageManager {
        static async sendMessage(chat, message, options = {}) {
            const chatId = typeof chat === 'string' ? chat : chat.id._serialized;
            return outboundQueue.enqueue(chatId, message, { critical: true, ...options });
        }

        static getMessageStats() {
            return getMessageStats();
        }

        static getQueueStatus() {
            return outboundQueue.getQueueStatus();
        }
    }

    class AdminManager {
        static getAdminList() {
            return getConfig().adminIds || [];
        }

        static isAdmin(userName, userId) {
            if (accessControl.isAdmin(userId, userName)) return true;
            const admins = this.getAdminList();
            if (!admins.length) return false;
            const normalizedName = normalizeId(userName).toLowerCase();
            const normalizedId = normalizeId(userId).toLowerCase();
            return admins.some((admin) => {
                const normalizedAdmin = normalizeId(admin).toLowerCase();
                return (
                    admin === userName ||
                    admin === userId ||
                    normalizedAdmin === normalizedName ||
                    normalizedAdmin === normalizedId
                );
            });
        }
    }

    class MathValidator {
        static validateExpression(expression) {
            const dangerousFunctions = ['eval', 'Function', 'constructor', 'prototype'];
            if (dangerousFunctions.some((name) => expression.includes(name))) {
                throw new Error('表达式包含不允许的函数');
            }
            if (expression.length > 1000) throw new Error('表达式过长');
            if (!/^[0-9+\-*/×÷()., \t\n\r]+$/.test(expression)) {
                throw new Error('表达式包含不允许的字符');
            }
            return true;
        }

        static safeEvaluate(expression) {
            this.validateExpression(expression);
            const normalized = expression.replace(/×/g, '*').replace(/÷/g, '/');
            const result = math.evaluate(normalized);
            if (!Number.isFinite(result)) throw new Error('计算结果无效');
            return Number.parseFloat(result.toFixed(4));
        }
    }

    class CommandProcessor {
        static async handleCommand(chat, message, userInfo) {
            const engine = getCommandEngine();
            if (!engine) throw new Error('命令引擎尚未初始化');
            const groupId = typeof chat === 'string' ? chat : chat.id._serialized;
            const text = (message && message.body ? message.body : '').trim();
            const classified = classifyCommand(text);
            if (classified.type === CMD.IGNORE) return undefined;
            const dto = Object.freeze({
                messageId: (message && message.id && message.id._serialized) || `legacy-${Date.now()}`,
                chatId: groupId,
                senderId: (userInfo && (userInfo.rawId || userInfo.id)) || '',
                body: text,
                type: (message && message.type) || 'chat',
                timestamp: (message && message.timestamp) || Math.floor(Date.now() / 1000),
                receivedAtNs: process.hrtime.bigint(),
                isGroup: String(groupId).endsWith('@g.us')
            });
            return engine.handle(dto, classified);
        }

        static isMathExpression(text) {
            return isMathExpression(text);
        }
    }

    return {
        Logger2: Logger,
        CapitalManager2: CapitalManager,
        MessageManager,
        AdminManager2: AdminManager,
        MathValidator,
        CommandProcessor
    };
}

module.exports = { createBotAdapters };
