const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const math = require('mathjs');
const crypto = require('crypto');
const moment = require('moment');
const _ = require('lodash');

// 控制台编码设置
if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
        console.log('✅ 控制台编码已设置为 UTF-8');
    } catch (error) {
        console.log('⚠️ 设置控制台编码失败，但不影响程序运行');
    }
}

process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

console.log('🚀 正在初始化 WhatsApp 机器人 2.0...');

// 配置管理
let DATA_DIR = path.join(__dirname, 'data');
let CAPITAL_DATA_PATH = path.join(DATA_DIR, 'capital.json');
let CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let LOG_DIR = path.join(DATA_DIR, 'logs');
let mainWindow = null;
let client;
let isConnected = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let reconnectDelay = 5000; // 5秒
let messageQueue = [];
let isProcessingQueue = false;
let heartbeatInterval;
let lastHeartbeat = Date.now();
let messageStats = {
    totalMessages: 0,
    processedMessages: 0,
    failedMessages: 0,
    lastReset: Date.now()
};

// 配置管理器
class ConfigManager {
    static defaultConfig = {
        version: "2.0.0",
        adminIds: ["你的用户名"],
        autoBackup: true,
        backupInterval: 24,
        maxHistoryRecords: 1000,
        cleanupDays: 30,
        enableNotifications: true,
        language: "zh-CN",
        theme: "default"
    };

    static getConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
                return _.merge({}, this.defaultConfig, config);
            }
        } catch (error) {
            console.error('读取配置文件失败:', error);
        }
        return this.defaultConfig;
    }

    static saveConfig(config) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
            return true;
        } catch (error) {
            console.error('保存配置文件失败:', error);
            return false;
        }
    }
}

// 资金管理器 2.0
class CapitalManager2 {
    static getData() {
        try {
            if (fs.existsSync(CAPITAL_DATA_PATH)) {
                return JSON.parse(fs.readFileSync(CAPITAL_DATA_PATH, 'utf8'));
            }
        } catch (error) {
            console.error('读取资金数据失败:', error);
        }
        return {};
    }

    static async saveData(data) {
        try {
            fs.writeFileSync(CAPITAL_DATA_PATH, JSON.stringify(data, null, 2));
            return true;
        } catch (error) {
            console.error('保存资金数据失败:', error);
            return false;
        }
    }

    static async getCapital(groupId) {
        const data = this.getData();
        if (!data[groupId]) {
            data[groupId] = {
                capital: 0,
                history: [],
                statistics: {
                    totalOperations: 0,
                    lastOperation: null,
                    createdDate: moment().toISOString()
                }
            };
            await this.saveData(data);
        }
        return data[groupId];
    }

    static async updateCapital(groupId, newValue, operation, userInfo = null) {
        const data = this.getData();
        if (!data[groupId]) {
            data[groupId] = {
                capital: 0,
                history: [],
                statistics: {
                    totalOperations: 0,
                    lastOperation: null,
                    createdDate: moment().toISOString()
                }
            };
        }

        const oldValue = data[groupId].capital;
        const change = newValue - oldValue;

        const record = {
            id: crypto.randomUUID(),
            timestamp: moment().toISOString(),
            operation: operation,
            oldValue: oldValue,
            newValue: newValue,
            change: change,
            user: userInfo ? {
                name: userInfo.name,
                id: userInfo.id
            } : null
        };

        const maxRecords = ConfigManager.getConfig().maxHistoryRecords;
        data[groupId].history.push(record);
        if (data[groupId].history.length > maxRecords) {
            data[groupId].history = data[groupId].history.slice(-maxRecords);
        }

        data[groupId].capital = newValue;
        data[groupId].statistics.totalOperations++;
        data[groupId].statistics.lastOperation = record;

        await this.saveData(data);
        return record;
    }

    static async getHistory(groupId, limit = 10) {
        const groupData = await this.getCapital(groupId);
        return groupData.history.slice(-limit);
    }

    static async clearCapital(groupId) {
        const data = this.getData();
        if (!data[groupId]) {
            data[groupId] = {
                capital: 0,
                history: [],
                statistics: {
                    totalOperations: 0,
                    lastOperation: null,
                    createdDate: moment().toISOString()
                }
            };
        } else {
            data[groupId].capital = 0;
            data[groupId].history = [];
            data[groupId].statistics.totalOperations = 0;
            data[groupId].statistics.lastOperation = null;
        }
        
        await this.saveData(data);
        return true;
    }
}

// 日志系统 2.0
class Logger2 {
    static write(logData) {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        
        const logPath = path.join(LOG_DIR, `${moment().format('YYYY-MM-DD')}.log`);
        const logEntry = JSON.stringify({
            timestamp: moment().toISOString(),
            ...logData
        }) + '\n';
        
        fs.appendFileSync(logPath, logEntry);

        if (mainWindow) {
            const logText = `${moment().format('HH:mm:ss')} [${logData.type}] ${logData.event || logData.action}`;
            mainWindow.webContents.send('log-update', logText);
        }
    }

    static system(event, details) {
        this.write({ type: 'SYSTEM', event, details });
    }

    static operation(groupId, action, user, capitalChange) {
        this.write({ type: 'OPERATION', groupId, action, user, ...capitalChange });
    }

    static error(error, context) {
        this.write({ type: 'ERROR', error: error.message, stack: error.stack, context });
    }
}

// 消息发送管理器 - 增强版
class MessageManager {
    static sendingMessages = new Set();
    static messageQueue = [];
    static isProcessingQueue = false;
    static maxQueueSize = 100;
    static processingDelay = 100; // 消息处理间隔

    // ✅ 新增：支持 options，并且队列里只存 chatId
    static async sendMessage(chat, message, options = {}) {
        const chatId = chat.id._serialized;
        const messageKey = this.getMessageKey(chatId, message);

        if (this.sendingMessages.has(messageKey)) return null;

        if (this.messageQueue.length >= this.maxQueueSize) {
            console.log('⚠️ 消息队列已满，丢弃最旧的消息');
            this.messageQueue.shift();
        }

        this.messageQueue.push({
            chatId,                 // ✅ 存 chatId，不存 chat 对象
            message,
            options,                // ✅ 存 options
            messageKey,
            timestamp: Date.now(),
            retries: 0,
            maxRetries: 3
        });

        if (!this.isProcessingQueue) {
            this.processMessageQueue();
        }

        return { id: { _serialized: 'queued_' + Date.now() } };
    }

    static async processMessageQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.messageQueue.length > 0) {
            const item = this.messageQueue.shift();

            // 超过 30 秒丢弃
            if (Date.now() - item.timestamp > 30000) {
                console.log('⚠️ 消息已过期，跳过发送');
                continue;
            }

            try {
                if (!isConnected) {
                    console.log('⚠️ 连接断开，消息重新入队');
                    this.messageQueue.unshift(item);
                    break;
                }

                this.sendingMessages.add(item.messageKey);

                // ✅ 关键修复：关闭 sendSeen，避免触发 markedUnread 崩溃
                const result = await client.sendMessage(
                    item.chatId,
                    item.message,
                    { sendSeen: false, ...item.options }
                );

                messageStats.processedMessages++;
                await this.delay(this.processingDelay);

            } catch (error) {
                console.error('❌ 消息发送错误:', error.message);
                messageStats.failedMessages++;

                if (item.retries < item.maxRetries) {
                    item.retries++;
                    console.log(`🔄 重试发送消息 (${item.retries}/${item.maxRetries})`);
                    this.messageQueue.unshift(item);
                    await this.delay(1000 * item.retries);
                }
            } finally {
                this.sendingMessages.delete(item.messageKey);
            }
        }

        this.isProcessingQueue = false;
    }

    static getMessageKey(chatId, message) {
        const messageHash = message.replace(/\s+/g, '').substring(0, 100);
        return `${chatId}_${messageHash}`;
    }

    static delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static getMessageStats() {
        return messageStats;
    }

    static resetMessageStats() {
        messageStats = {
            totalMessages: 0,
            processedMessages: 0,
            failedMessages: 0,
            lastReset: Date.now()
        };
    }

    static getQueueStatus() {
        return {
            queueLength: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            sendingMessages: this.sendingMessages.size
        };
    }
}

// 管理员管理器 2.0
class AdminManager2 {
    static getAdminList() {
        try {
            const config = ConfigManager.getConfig();
            return config.adminIds || [];
        } catch (error) {
            console.error('读取管理员配置失败:', error);
            return [];
        }
    }

    static isAdmin(userName, userId) {
        const adminList = this.getAdminList();
        
        if (!Array.isArray(adminList) || adminList.length === 0) {
            console.log('⚠️ 管理员列表为空，请检查配置文件');
            return false;
        }
        
        // 检查输入参数是否有效
        if (!userName && !userId) {
            return false;
        }
        
        return adminList.some(admin => {
            // 安全地处理可能为null的参数
            const safeUserName = userName || '';
            const safeUserId = userId || '';
            
            // 标准化处理：移除 @c.us、@lid 等后缀
            const normalizedUserName = safeUserName.replace(/@[^.]+\.us$/, '').replace(/@lid$/, '');
            const normalizedUserId = safeUserId.replace(/@[^.]+\.us$/, '').replace(/@lid$/, '');
            const normalizedAdmin = admin.replace(/@[^.]+\.us$/, '').replace(/@lid$/, '');
            
            return admin === userName || 
                   admin === userId || 
                   admin === normalizedUserName ||
                   admin === normalizedUserId ||
                   normalizedAdmin === normalizedUserName ||
                   normalizedAdmin === normalizedUserId;
        });
    }

    static logUnauthorizedAccess(userInfo, groupId, message) {
        // console.log(`🚫 非管理员用户尝试操作: ${userInfo.name} (${userInfo.id})`);
        Logger2.error(new Error('未授权访问'), { userInfo, groupId, message: message.substring(0, 50) });
    }

    static logAuthorizedAccess(userInfo) {
        // console.log(`✅ 管理员操作: ${userInfo.name} (${userInfo.id})`);
    }
}

// 数学表达式验证器
class MathValidator {
    static validateExpression(expression) {
        const dangerousFunctions = ['eval', 'Function', 'constructor', 'prototype'];
        if (dangerousFunctions.some(func => expression.includes(func))) {
            throw new Error('表达式包含不允许的函数');
        }

        if (expression.length > 1000) {
            throw new Error('表达式过长');
        }

        const allowedChars = /^[0-9+\-*/×÷()., \t\n\r]+$/;
        if (!allowedChars.test(expression)) {
            throw new Error('表达式包含不允许的字符');
        }

        return true;
    }

    static safeEvaluate(expression) {
        this.validateExpression(expression);
        
        try {
            // 将×和÷符号转换为*和/
            const normalizedExpression = expression
                .replace(/×/g, '*')
                .replace(/÷/g, '/');
            
            const result = math.evaluate(normalizedExpression);
            if (!isFinite(result)) {
                throw new Error('计算结果无效');
            }
            return parseFloat(result.toFixed(4));
        } catch (error) {
            throw new Error(`计算错误: ${error.message}`);
        }
    }
}

// 命令处理器
class CommandProcessor {
    static async handleCommand(chat, message, userInfo) {
        const groupId = chat.id._serialized;
        const text = message.body.trim();
        
        // console.log(`\n🔧 命令处理器开始处理:`);
        // console.log(`   - 群组ID: ${groupId}`);
        // console.log(`   - 用户信息: ${userInfo.name} (${userInfo.id})`);
        // console.log(`   - 消息内容: "${text}"`);
        
        if (!AdminManager2.isAdmin(userInfo.name, userInfo.id)) {
            // console.log(`🚫 非管理员用户，跳过处理`);
            AdminManager2.logUnauthorizedAccess(userInfo, groupId, text);
            return;
        }

        // console.log(`✅ 管理员用户，继续处理`);
        AdminManager2.logAuthorizedAccess(userInfo);

        // 精确匹配特定命令（支持斜杠前缀）
        const exactCommands = {
            '/撤回': () => this.handleRevokeCommand(chat, groupId, userInfo),
            '/清账': () => this.handleClearCommand(chat, groupId, userInfo),
            '/查账': () => this.handleQueryCommand(chat, groupId, userInfo),
            '/帮助': () => this.handleHelpCommand(chat),
            '撤回': () => this.handleRevokeCommand(chat, groupId, userInfo),
            '清账': () => this.handleClearCommand(chat, groupId, userInfo),
            '查账': () => this.handleQueryCommand(chat, groupId, userInfo),
            '帮助': () => this.handleHelpCommand(chat)
        };

        // 检查是否为精确命令匹配
        for (const [command, handler] of Object.entries(exactCommands)) {
            if (text === command) {
                console.log(`🎯 匹配到精确命令: "${command}"`);
                return await handler();
            }
        }

        // 检查是否为简单加减法运算（如 +100, -50, +100#预付款）
        if (/^[+\-]\s*\d+(\.\d+)?(\s*#.*)?$/.test(text.trim())) {
            console.log(`🔢 匹配到简单计算命令: "${text}"`);
            return await this.handleCalculationCommand(chat, groupId, userInfo, text);
        }

        // 检查是否为复合数学表达式
        if (this.isMathExpression(text)) {
            console.log(`🧮 匹配到复合数学表达式: "${text}"`);
            return await this.handleMathExpressionCommand(chat, groupId, userInfo, text);
        }

        // 检查是否为简单数字设置（移除自动数字设置功能）
        // if (/^\d+(\.\d+)?$/.test(text)) {
        //     return await this.handleDirectNumberCommand(chat, groupId, userInfo, text);
        // }

        // 对于非命令消息，机器人不做任何反应
        console.log(`📝 管理员 ${userInfo.name} 发送了非命令消息: "${text}" - 机器人无响应`);
        return;
    }

    // 判断是否为数学表达式
    static isMathExpression(text) {
        // 移除所有空格
        const cleanText = text.replace(/\s/g, '');
        
        // 检查是否以运算符开头（必须要求）
        const startsWithOperator = /^[+\-*/×÷]/.test(cleanText);
        
        // 检查是否包含数学运算符（包括×和÷符号）
        const hasOperator = /[+\-*/×÷()]/.test(cleanText);
        
        // 检查是否主要包含数字和运算符（允许#注释）
        const isMathPattern = /^[\d+\-*/×÷().,]+(\s*#.*)?$/.test(cleanText);
        
        // 检查是否为复杂表达式（包含多个运算符或括号）
        const isComplexExpression = /[+\-*/×÷].*[+\-*/×÷]/.test(cleanText) || /[()]/.test(cleanText);
        
        // 必须以运算符开头，且包含运算符
        return startsWithOperator && hasOperator && (isMathPattern || isComplexExpression);
    }

    static async handleQueryCommand(chat, groupId, userInfo) {
        try {
            const groupData = await CapitalManager2.getCapital(groupId);
            const history = await CapitalManager2.getHistory(groupId, 5);
            
            let message = `💰 当前余额: ${groupData.capital}\n\n`;
            
            if (history.length > 0) {
                message += '📜 最近操作:\n';
                history.reverse().forEach((record, index) => {
                    const time = moment(record.timestamp).format('MM-DD HH:mm');
                    const change = record.change >= 0 ? `+${record.change}` : `${record.change}`;
                    message += `${index + 1}. ${time} ${record.operation}\n`;
                    message += `   原值: ${record.oldValue} → 新值: ${record.newValue} (${change})\n`;
                });
            } else {
                message += '📝 暂无操作记录';
            }
            
            await MessageManager.sendMessage(chat, message);
            Logger2.operation(groupId, 'QUERY', userInfo, { currentCapital: groupData.capital });
            
        } catch (error) {
            console.error('查账出错:', error);
            await MessageManager.sendMessage(chat, '❌ 查询失败: ' + error.message);
        }
    }

    static async handleClearCommand(chat, groupId, userInfo) {
        try {
            const beforeClear = await CapitalManager2.getCapital(groupId);
            await CapitalManager2.clearCapital(groupId);
            
            await MessageManager.sendMessage(chat,
                '🔄 清账成功\n' +
                '当前余额: 0\n' +
                '历史记录已全部清除'
            );
            
            Logger2.operation(groupId, 'CLEAR', userInfo, {
                before: beforeClear.capital,
                after: 0
            });
            
        } catch (error) {
            console.error('清账出错:', error);
            await MessageManager.sendMessage(chat, '❌ 清账失败: ' + error.message);
        }
    }

    static async handleRevokeCommand(chat, groupId, userInfo) {
        try {
            const history = await CapitalManager2.getHistory(groupId, 2);
            
            if (history.length === 0) {
                await MessageManager.sendMessage(chat, '❌ 没有可撤回的操作');
                return;
            }
            
            const lastOperation = history[history.length - 1]; // 最新操作
            const groupData = await CapitalManager2.getCapital(groupId);
            const currentValue = groupData.capital;
            
            // 撤回操作：恢复到上一个值
            let previousValue;
            if (history.length >= 2) {
                // 如果有多个操作，使用倒数第二个操作的newValue
                const previousOperation = history[history.length - 2];
                previousValue = previousOperation.newValue;
            } else {
                // 如果只有一个操作，恢复到0
                previousValue = 0;
            }
            
            await CapitalManager2.updateCapital(groupId, previousValue, `撤回操作: ${lastOperation.operation}`, userInfo);
            
            const message = `↩️ 撤回成功\n` +
                `撤回操作: ${lastOperation.operation}\n` +
                `撤回前余额: ${currentValue}\n` +
                `撤回后余额: ${previousValue}\n` +
                `撤回的操作值: ${lastOperation.newValue}`;
            
            await MessageManager.sendMessage(chat, message);
            Logger2.operation(groupId, 'REVOKE', userInfo, {
                revokedOperation: lastOperation,
                before: currentValue,
                after: previousValue
            });
            
        } catch (error) {
            console.error('撤回操作出错:', error);
            await MessageManager.sendMessage(chat, '❌ 撤回失败: ' + error.message);
        }
    }

    static async handleHelpCommand(chat) {
        const message = `🤖 WhatsApp资金管理机器人 2.0 帮助\n\n` +
            `📋 可用命令:\n` +
            `• /查账 或 查账 - 查看当前余额和最近操作\n` +
            `• /清账 或 清账 - 清空所有数据和历史记录\n` +
            `• /撤回 或 撤回 - 撤回最近一次操作\n` +
            `• /帮助 或 帮助 - 显示此帮助信息\n\n` +
            `🔢 数学计算:\n` +
            `• 简单计算: +100, -50, *2, /3\n` +
            `• 带注释计算: +100#预付款, -50#退款, *2#翻倍\n` +
            `• 复合表达式: +1+2*3, *(100+50)/2, 等等\n` +
            `• 复合表达式带注释: +100*2#双倍预付款\n` +
            `• 支持的符号: +、-、*、/、×、÷\n\n` +
            `💡 提示:\n` +
            `• 只有管理员可以使用这些命令\n` +
            `• 计算命令必须以符号开头\n` +
            `• 使用 # 添加备注说明\n` +
            `• 新群组初始余额为0，无需设置\n` +
            `• 其他消息（包括闲聊）机器人不会回应`;
        
        await MessageManager.sendMessage(chat, message);
    }

    static async handleMathExpressionCommand(chat, groupId, userInfo, expression) {
        try {
            // 分离计算部分和注释部分
            const parts = expression.split('#');
            const calculationPart = parts[0].trim();
            const comment = parts.length > 1 ? parts[1].trim() : '';
            
            const groupData = await CapitalManager2.getCapital(groupId);
            const currentValue = groupData.capital;
            
            // 将复合表达式应用到当前余额上
            const fullExpression = `(${currentValue})${calculationPart}`;
            const result = MathValidator.safeEvaluate(fullExpression);
            
            // 构建操作描述
            const operationDesc = comment ? 
                `计算: ${calculationPart} = ${result} (${comment})` : 
                `计算: ${calculationPart} = ${result}`;
            
            await CapitalManager2.updateCapital(groupId, result, operationDesc, userInfo);
            const updatedData = await CapitalManager2.getCapital(groupId);
            
            const change = result - currentValue;
            const message = `🔢 复合计算成功\n` +
                `当前余额: ${updatedData.capital}\n` +
                `原值: ${currentValue}\n` +
                `算式: ${fullExpression} = ${result}\n` +
                `变化: ${change >= 0 ? '+' : ''}${change}` +
                (comment ? `\n备注: ${comment}` : '');
            
            await MessageManager.sendMessage(chat, message);
            Logger2.operation(groupId, 'MATH_EXPRESSION', userInfo, {
                before: currentValue,
                after: result,
                expression: fullExpression,
                comment: comment
            });
            
        } catch (error) {
            console.error('复合计算出错:', error);
            await MessageManager.sendMessage(chat, `❌ 计算错误: ${error.message}`);
        }
    }

    static async handleCalculationCommand(chat, groupId, userInfo, expression) {
        try {
            // 分离计算部分和注释部分
            const parts = expression.split('#');
            const calculationPart = parts[0].trim();
            const comment = parts.length > 1 ? parts[1].trim() : '';
            
            const operator = calculationPart[0];
            const value = calculationPart.substring(1).trim();
            
            const groupData = await CapitalManager2.getCapital(groupId);
            const currentValue = groupData.capital;
            
            const fullExpression = `(${currentValue})${operator}(${value})`;
            const result = MathValidator.safeEvaluate(fullExpression);
            
            // 构建操作描述
            const operationDesc = comment ? 
                `计算: ${calculationPart} = ${result} (${comment})` : 
                `计算: ${calculationPart} = ${result}`;
            
            await CapitalManager2.updateCapital(groupId, result, operationDesc, userInfo);
            const updatedData = await CapitalManager2.getCapital(groupId);
            
            const change = result - currentValue;
            const message = `🔢 计算成功\n` +
                `当前余额: ${updatedData.capital}\n` +
                `原值: ${currentValue}\n` +
                `算式: ${fullExpression}\n` +
                `新值: ${result}\n` +
                `变化: ${change >= 0 ? '+' : ''}${change}` +
                (comment ? `\n备注: ${comment}` : '');
            
            await MessageManager.sendMessage(chat, message);
            Logger2.operation(groupId, 'CALCULATION', userInfo, {
                before: currentValue,
                after: result,
                expression: fullExpression,
                comment: comment
            });
            
        } catch (error) {
            console.error('计算出错:', error);
            await MessageManager.sendMessage(chat, `❌ 计算错误: ${error.message}`);
        }
    }

    static async handleDirectNumberCommand(chat, groupId, userInfo, number) {
        try {
            const newValue = parseFloat(number);
            const groupData = await CapitalManager2.getCapital(groupId);
            const oldValue = groupData.capital;
            
            await CapitalManager2.updateCapital(groupId, newValue, `设置为 ${newValue}`, userInfo);
            
            const message = `💰 金额设置成功\n` +
                `原值: ${oldValue}\n` +
                `新值: ${newValue}\n` +
                `变化: ${newValue - oldValue >= 0 ? '+' : ''}${newValue - oldValue}`;
            
            await MessageManager.sendMessage(chat, message);
            Logger2.operation(groupId, 'SET_VALUE', userInfo, {
                before: oldValue,
                after: newValue
            });
            
        } catch (error) {
            console.error('设置金额出错:', error);
            await MessageManager.sendMessage(chat, `❌ 设置失败: ${error.message}`);
        }
    }
}

// 查找Edge浏览器路径
function findEdgePath() {
    const possiblePaths = [
        // Windows Edge (Chromium版本)
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        // Windows Edge (旧版本)
        'C:\\Windows\\System32\\MicrosoftEdge.exe',
        // 用户目录下的Edge
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
        // 备用路径
        'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge Canary\\Application\\msedge.exe'
    ];

    for (const edgePath of possiblePaths) {
        if (fs.existsSync(edgePath)) {
            console.log(`✅ 找到Edge浏览器: ${edgePath}`);
            return edgePath;
        }
    }

    console.log('⚠️ 未找到Edge浏览器，将尝试使用系统默认浏览器');
    return null;
}

// 查找Chrome浏览器路径（备用）
function findChromePath() {
    const possiblePaths = [
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];

    for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
            console.log(`✅ 找到Chrome浏览器: ${chromePath}`);
            return chromePath;
        }
    }

    console.log('⚠️ 未找到Chrome浏览器');
    return null;
}

// 初始化函数
function init(config) {
    if (config && config.dataDir) {
        DATA_DIR = config.dataDir;
        CAPITAL_DATA_PATH = path.join(DATA_DIR, 'capital.json');
        CONFIG_PATH = path.join(DATA_DIR, 'config.json');
        LOG_DIR = path.join(DATA_DIR, 'logs');
    }

    [DATA_DIR, LOG_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            // console.log(`✅ 创建目录成功: ${dir}`);
        }
    });

    if (!fs.existsSync(CONFIG_PATH)) {
        ConfigManager.saveConfig(ConfigManager.defaultConfig);
        // console.log('✅ 创建初始配置文件成功');
    }

    if (!fs.existsSync(CAPITAL_DATA_PATH)) {
        const initialData = {
            "_description": "资金管理配置文件 2.0"
        };
        fs.writeFileSync(CAPITAL_DATA_PATH, JSON.stringify(initialData, null, 2));
        // console.log('✅ 创建初始资金数据文件成功');
    }

    // 优先使用Edge浏览器
    const edgePath = findEdgePath();
    const chromePath = !edgePath ? findChromePath() : null;
    const browserPath = edgePath || chromePath;
    
    const puppeteerConfig = {
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-field-trial-config',
            '--disable-ipc-flooding-protection',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-client-side-phishing-detection',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-first-run',
            '--safebrowsing-disable-auto-update',
            '--ignore-certificate-errors',
            '--ignore-ssl-errors',
            '--ignore-certificate-errors-spki-list',
            '--allow-running-insecure-content'
        ]
    };

    if (browserPath) {
        puppeteerConfig.executablePath = browserPath;
        console.log(`✅ 使用浏览器: ${browserPath}`);
    } else {
        console.log('⚠️ 未找到Edge或Chrome浏览器，使用系统默认浏览器');
    }

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
        puppeteer: puppeteerConfig
    });

    // console.log('✅ 初始化完成');
}

// 机器人启动管理器 2.0
class BotStartupManager {
    static startupStates = {
        IDLE: 'idle',
        INITIALIZING: 'initializing',
        AUTHENTICATING: 'authenticating',
        CONNECTING: 'connecting',
        READY: 'ready',
        ERROR: 'error',
        STOPPING: 'stopping'
    };

    static currentState = this.startupStates.IDLE;
    static startupStartTime = null;
    static startupProgress = 0;
    static startupSteps = [
        '环境检查',
        '配置验证',
        '客户端初始化',
        '事件监听器设置',
        '启动客户端',
        '心跳启动',
        '启动完成'
    ];

    static async startBot() {
        try {
            console.log('🚀 开始启动 WhatsApp 机器人 2.0...');
            this.currentState = this.startupStates.INITIALIZING;
            this.startupStartTime = Date.now();
            this.startupProgress = 0;

            // 步骤1: 环境检查
            await this.performEnvironmentCheck();
            this.updateProgress(1);

            // 步骤2: 配置验证
            await this.validateConfiguration();
            this.updateProgress(2);

            // 步骤3: 客户端初始化
            await this.initializeClient();
            this.updateProgress(3);

            // 步骤4: 设置事件监听器
            this.setupEventListeners();
            this.updateProgress(4);

            // 步骤5: 启动客户端
            await this.startClient();
            this.updateProgress(5);

            // 步骤6: 启动心跳
            this.startHeartbeat();
            this.updateProgress(6);

            // 步骤7: 启动完成
            this.completeStartup();
            this.updateProgress(7);

            Logger2.system('BOT_STARTUP_SUCCESS', {
                duration: Date.now() - this.startupStartTime,
                timestamp: moment().toISOString()
            });

        } catch (error) {
            await this.handleStartupError(error);
        }
    }

    static async performEnvironmentCheck() {
        console.log('🔍 执行环境检查...');
        
        // 检查必要的目录
        const requiredDirs = [DATA_DIR, LOG_DIR];
        for (const dir of requiredDirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`✅ 创建目录: ${dir}`);
            }
        }

        // 检查Chrome浏览器（优先）
        const chromePath = findChromePath();
        if (!chromePath) {
            // 如果没找到Chrome，尝试Edge
            const edgePath = findEdgePath();
            if (!edgePath) {
                console.log('⚠️ 未找到Chrome或Edge浏览器，将使用系统默认浏览器');
            }
        }

        // 跳过网络连接检查（直接启动）
        console.log('🌐 跳过网络连接检查，直接启动机器人...');

        // 检查必要的文件
        if (!fs.existsSync(CONFIG_PATH)) {
            ConfigManager.saveConfig(ConfigManager.defaultConfig);
            console.log('✅ 创建默认配置文件');
        }

        if (!fs.existsSync(CAPITAL_DATA_PATH)) {
            const initialData = { "_description": "资金管理配置文件 2.0" };
            fs.writeFileSync(CAPITAL_DATA_PATH, JSON.stringify(initialData, null, 2));
            console.log('✅ 创建初始资金数据文件');
        }

        console.log('✅ 环境检查完成');
    }

    static async checkNetworkConnectionWithRetry() {
        console.log('🌐 检查网络连接...');
        
        const urls = [
            'https://web.whatsapp.com',
            'https://www.google.com',
            'https://www.baidu.com'
        ];
        
        let connectionSuccess = false;
        
        for (const url of urls) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const success = await this.testConnection(url, attempt);
                    if (success) {
                        connectionSuccess = true;
                        break;
                    }
                } catch (error) {
                    console.log(`   ⚠️ ${url} - 尝试 ${attempt}/3 失败: ${error.message}`);
                }
                
                if (attempt < 3) {
                    console.log(`   🔄 等待 2 秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
            
            if (connectionSuccess) break;
        }
        
        if (!connectionSuccess) {
            console.log('   ⚠️ Node.js网络连接测试失败');
            console.log('   💡 注意: 如果浏览器可以访问WhatsApp Web，说明网络正常');
            console.log('   💡 这可能是Node.js网络请求被防火墙阻止，但不影响机器人运行');
            console.log('   ✅ 继续启动机器人...');
        } else {
            console.log('   ✅ 网络连接正常');
        }
        console.log('');
    }

    static async testConnection(url, attempt) {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const http = require('http');
            const isHttps = url.startsWith('https://');
            const client = isHttps ? https : http;
            
            const options = {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Cache-Control': 'max-age=0'
                },
                // 添加这些选项来绕过一些网络限制
                rejectUnauthorized: false,
                secureProtocol: 'TLSv1_2_method'
            };
            
            const req = client.get(url, options, (res) => {
                // 即使状态码不是200，只要能连接就算成功
                if (res.statusCode >= 200 && res.statusCode < 500) {
                    console.log(`   ✅ ${url} - 状态码: ${res.statusCode} (尝试 ${attempt}/3)`);
                    resolve(true);
                } else {
                    console.log(`   ⚠️ ${url} - 状态码: ${res.statusCode} (尝试 ${attempt}/3)`);
                    resolve(true); // 仍然算作连接成功
                }
            });
            
            req.on('error', (err) => {
                if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message.includes('socket hang up')) {
                    reject(new Error(`连接被重置: ${err.code}`));
                } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                    reject(new Error(`无法连接到服务器: ${err.code}`));
                } else if (err.code === 'ETIMEDOUT') {
                    reject(new Error('连接超时'));
                } else {
                    reject(new Error(err.message));
                }
            });
            
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('请求超时'));
            });
        });
    }

    static async validateConfiguration() {
        console.log('⚙️ 验证配置...');
        
        const config = ConfigManager.getConfig();
        
        // 验证管理员配置
        if (!config.adminIds || config.adminIds.length === 0) {
            console.log('⚠️ 警告: 未配置管理员，请检查配置文件');
        } else {
            console.log(`✅ 管理员配置: ${config.adminIds.length} 个管理员`);
        }

        // 验证其他配置
        const requiredConfigs = ['version', 'autoBackup', 'maxHistoryRecords'];
        for (const key of requiredConfigs) {
            if (config[key] === undefined) {
                console.log(`⚠️ 配置项 ${key} 缺失，使用默认值`);
            }
        }

        console.log('✅ 配置验证完成');
    }

    static async initializeClient() {
        console.log('🔧 初始化客户端...');
        
        // 优先使用Chrome浏览器
        const chromePath = findChromePath();
        const edgePath = !chromePath ? findEdgePath() : null;
        const browserPath = chromePath || edgePath;
        
        // 精简的Puppeteer配置 - 只保留必要的参数
        const puppeteerConfig = {
            headless: false,
            executablePath: browserPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--no-first-run',
                '--no-zygote',
                '--window-size=1280,720'
            ],
            timeout: 120000,
            protocolTimeout: 120000
        };

        if (browserPath) {
            puppeteerConfig.executablePath = browserPath;
            console.log(`✅ 使用浏览器: ${browserPath}`);
        } else {
            console.log('⚠️ 未找到Chrome或Edge浏览器，使用系统默认浏览器');
        }

        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: DATA_DIR,
                clientId: 'whatsapp-bot-v2'   // 新增，区分会话
            }),
            puppeteer: puppeteerConfig,
            // 关键：让 wwebjs 自动拉取兼容的 WA Web 版本
            webVersionCache: { 
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
            },
            // 关键：多设备/并发登录时，自动接管，避免卡死
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0
        });

        // ✅ 全局兜底：任何 sendMessage 默认不 sendSeen
        const rawSendMessage = client.sendMessage.bind(client);
        client.sendMessage = (chatId, content, options = {}) => {
            return rawSendMessage(chatId, content, { sendSeen: false, ...options });
        };

        console.log('✅ 客户端初始化完成');
    }

    static setupEventListeners() {
        console.log('👂 设置事件监听器...');

        // 消息事件监听器
    client.on('message', async msg => {
        try {
            if (msg.fromMe) return;

            // 更新消息统计
            messageStats.totalMessages++;

            const chat = await msg.getChat();
            
            // ✅ 安全获取联系人信息，兼容新版本 WhatsApp Web
            let contact = null;
            try {
                contact = await msg.getContact();
            } catch (error) {
                console.log('⚠️ getContact() 失败，使用备用方案:', error.message);
            }
            
            const senderID = msg.author || msg.from;
            
            // ✅ 提取用户 ID，优先使用 contact.number，否则清理 senderID 中的后缀
            let userId = contact?.number;
            if (!userId && senderID) {
                userId = senderID.replace(/@[^.]+\.us$/, '').replace(/@lid$/, '');
            }
            if (!userId) {
                userId = senderID || "Unknown";
            }
            
            const userInfo = {
                name: contact?.pushname || contact?.name || msg._data.notifyName || msg._data.notify || "Unknown",
                id: userId,   // ✅ 优先用 number，更稳定
                rawId: senderID                   // 可留作调试
            };

            // 输出获取到的消息信息
            console.log('\n📨 收到新消息:');
            console.log(`   - 消息内容: "${msg.body}"`);
            console.log(`   - 发送者: ${userInfo.name} (${userInfo.id})`);
            console.log(`   - 群组ID: ${chat.id._serialized}`);
            console.log(`   - 消息类型: ${msg.type}`);
            console.log(`   - 时间戳: ${new Date(msg.timestamp * 1000).toLocaleString()}`);
            console.log(`   - 是否群组: ${chat.isGroup}`);

            // 检查连接状态
            if (!isConnected) {
                console.log('⚠️ 连接断开，跳过消息处理');
                return;
            }

            // 异步处理消息，避免阻塞
            setImmediate(async () => {
                try {
                    console.log(`🔍 开始处理消息: "${msg.body}"`);
                    await CommandProcessor.handleCommand(chat, msg, userInfo);
                    console.log(`✅ 消息处理完成: "${msg.body}"`);
                } catch (error) {
                    console.error('❌ 处理消息时出错:', error);
                    Logger2.error(error, { context: 'message_handler' });
                }
            });

        } catch (error) {
            console.error('❌ 消息预处理时出错:', error);
            Logger2.error(error, { context: 'message_preprocessor' });
        }
    });

        // 连接状态事件监听器 - 合并ready事件

        client.on('auth_failure', (msg) => {
            console.error('❌ WhatsApp 身份验证失败:', msg);
            this.currentState = this.startupStates.ERROR;
            Logger2.error(new Error('身份验证失败'), { message: msg });
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp 连接断开:', reason);
        isConnected = false;
        stopHeartbeat();
            this.currentState = this.startupStates.ERROR;
        handleDisconnection(reason);
        Logger2.system('DISCONNECTED', { reason, timestamp: moment().toISOString() });
    });

        client.on('qr', (qr) => {
            console.log('📱 请扫描二维码登录 WhatsApp');
            qrcode.generate(qr, { small: true });
            this.currentState = this.startupStates.AUTHENTICATING;
        });

        client.on('loading_screen', (percent, message) => {
            console.log(`⏳ 加载中: ${percent}% - ${message}`);
        });

        // 添加更多调试事件监听器
        client.on('change_state', (state) => {
            console.log(`🔄 状态变化: ${state}`);
        });

        client.on('change_battery', (batteryInfo) => {
            console.log(`🔋 电池状态: ${batteryInfo.battery}% (充电中: ${batteryInfo.plugged})`);
        });

        // 添加连接超时监控
        let connectionTimeout;
        const startConnectionTimeout = () => {
            connectionTimeout = setTimeout(() => {
                if (!isConnected) {
                    console.log('⏰ 连接超时，尝试重新连接...');
                    this.handleConnectionTimeout();
                }
            }, 60000); // 60秒超时
        };

        const clearConnectionTimeout = () => {
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }
        };

        // 在认证成功后启动超时监控
        client.on('authenticated', () => {
            console.log('🔐 WhatsApp 身份验证成功');
            Logger2.system('AUTHENTICATED', { timestamp: moment().toISOString() });
            startConnectionTimeout();
        });

        // 在连接成功后清除超时 - 合并的ready事件
        client.on('ready', async () => {
            clearConnectionTimeout && clearConnectionTimeout();
            console.log('✅ WhatsApp 客户端已准备就绪');
            isConnected = true;
            reconnectAttempts = 0;
            this.currentState = this.startupStates.READY;
            
            // 新增：记录实际注入到的 WhatsApp Web 版本，便于排障
            try { 
                const wwebVersion = await client.getWWebVersion();
                console.log(`📱 WhatsApp Web 版本: ${wwebVersion}`);
            } catch (error) {
                console.log('⚠️ 无法获取 WhatsApp Web 版本');
            }
            
            // 显示最终启动成功消息
            const totalDuration = Date.now() - this.startupStartTime;
            console.log('🎉 机器人完全启动成功！');
            console.log(`📊 最终统计:`);
            console.log(`   - 总启动时间: ${totalDuration}ms`);
            console.log(`   - 当前状态: ${this.currentState}`);
            console.log(`   - 连接状态: 已连接`);
            console.log('🤖 机器人现在可以接收和处理消息了！');
            
            Logger2.system('CLIENT_READY', { 
                timestamp: moment().toISOString(),
                totalStartupTime: totalDuration
            });
        });

        console.log('✅ 事件监听器设置完成');
    }

    static async startClient() {
        console.log('🚀 启动客户端...');
        this.currentState = this.startupStates.CONNECTING;
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('客户端启动超时'));
            }, 120000); // 2分钟超时

            client.initialize().then(() => {
                clearTimeout(timeout);
                resolve();
            }).catch((error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    static startHeartbeat() {
        console.log('💓 启动心跳机制...');
        if (!heartbeatInterval) {
            startHeartbeat();
        } else {
            console.log('💓 心跳机制已在运行');
        }
    }

    static completeStartup() {
        const duration = Date.now() - this.startupStartTime;
        console.log(`🎉 机器人启动流程完成！耗时: ${duration}ms`);
        console.log('📊 启动统计:');
        console.log(`   - 总耗时: ${duration}ms`);
        console.log(`   - 启动步骤: ${this.startupSteps.length}`);
        console.log(`   - 当前状态: ${this.currentState}`);
        console.log(`   - 连接状态: ${isConnected ? '已连接' : '等待连接'}`);
        console.log('⏳ 等待 WhatsApp 连接建立...');
        
        // 注意：这里不设置状态为READY，因为真正的连接状态由'ready'事件控制
    }

    static async handleStartupError(error) {
        console.error('❌ 机器人启动失败:', error.message);
        this.currentState = this.startupStates.ERROR;
        
        Logger2.error(error, {
            context: 'bot_startup',
            startupProgress: this.startupProgress,
            startupStep: this.startupSteps[this.startupProgress] || 'unknown',
            timestamp: moment().toISOString()
        });

        // 清理资源
        if (client) {
            try {
                await client.destroy();
            } catch (cleanupError) {
                console.error('清理客户端时出错:', cleanupError);
            }
        }

        // 重置状态
        isConnected = false;
        reconnectAttempts = 0;
        stopHeartbeat();

        throw error;
    }

    static updateProgress(step) {
        this.startupProgress = step;
        const progress = Math.round((step / this.startupSteps.length) * 100);
        console.log(`📈 启动进度: ${progress}% - ${this.startupSteps[step - 1]}`);
        
        if (mainWindow) {
            mainWindow.webContents.send('startup-progress', {
                step,
                progress,
                currentStep: this.startupSteps[step - 1],
                totalSteps: this.startupSteps.length
            });
        }
    }

    static getStartupStatus() {
        return {
            state: this.currentState,
            progress: this.startupProgress,
            totalSteps: this.startupSteps.length,
            currentStep: this.startupSteps[this.startupProgress - 1] || 'unknown',
            startTime: this.startupStartTime,
            duration: this.startupStartTime ? Date.now() - this.startupStartTime : 0
        };
    }

    static async handleConnectionTimeout() {
        console.log('⏰ 连接超时处理...');
        
        try {
            // 尝试重新初始化客户端
            if (client) {
                console.log('🔄 尝试重新初始化客户端...');
                await client.destroy();
                
                // 等待一段时间后重新创建客户端
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // 重新初始化
                await this.initializeClient();
                this.setupEventListeners();
                await this.startClient();
                
                console.log('🔄 客户端重新初始化完成');
            }
        } catch (error) {
            console.error('❌ 连接超时处理失败:', error);
            Logger2.error(error, { context: 'connection_timeout' });
        }
    }

    static async stopBot() {
        console.log('🛑 正在停止机器人...');
        this.currentState = this.startupStates.STOPPING;

        try {
            // 停止心跳
            stopHeartbeat();

            // 断开客户端
            if (client) {
                await client.destroy();
            }

            // 重置状态
            isConnected = false;
            this.currentState = this.startupStates.IDLE;
            this.startupProgress = 0;

            console.log('✅ 机器人已停止');
            Logger2.system('BOT_STOPPED', { timestamp: moment().toISOString() });

        } catch (error) {
            console.error('❌ 停止机器人时出错:', error);
            Logger2.error(error, { context: 'bot_stop' });
            throw error;
        }
    }
}

// 启动机器人 - 使用新的启动管理器
function startBot() {
    return BotStartupManager.startBot();
}

// 连接管理函数 - 修复断线重连逻辑
async function handleDisconnection(reason) {
    console.log(`🔌 处理断开连接: ${reason}`);
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error('❌ 达到最大重连次数，停止重连');
        Logger2.error(new Error('连接失败'), { reason, attempts: reconnectAttempts, timestamp: moment().toISOString() });
        return;
    }
    reconnectAttempts++;
    const delay = reconnectDelay * reconnectAttempts;
    console.log(`🔄 ${reconnectAttempts}/${maxReconnectAttempts}，${delay}ms 后重建客户端...`);
    setTimeout(async () => {
        try {
            if (client) { try { await client.destroy(); } catch {} }
            await BotStartupManager.initializeClient();
            BotStartupManager.setupEventListeners();
            await BotStartupManager.startClient();
        } catch (error) {
            console.error('❌ 重连失败:', error);
            handleDisconnection(reason);
        }
    }, delay);
}

// 心跳机制
function startHeartbeat() {
    console.log('💓 启动心跳机制...');
    heartbeatInterval = setInterval(() => {
        try {
            if (client && isConnected) {
                // 发送心跳检测
                lastHeartbeat = Date.now();
                // console.log('💓 心跳正常');
            }
        } catch (error) {
            console.error('💔 心跳检测失败:', error);
            isConnected = false;
            handleDisconnection('heartbeat_failed');
        }
    }, 30000); // 每30秒检测一次
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log('💓 心跳机制已停止');
    }
}

// 获取连接状态
function getConnectionStatus() {
    return {
        isConnected,
        reconnectAttempts,
        lastHeartbeat,
        uptime: Date.now() - lastHeartbeat
    };
}

// 获取消息统计
function getMessageStats() {
    return messageStats;
}

// 设置主窗口引用
function setMainWindow(window) {
    mainWindow = window;
}

// 导出模块
module.exports = {
    init,
    startBot,
    setMainWindow,
    getConnectionStatus,
    getMessageStats,
    ConfigManager,
    CapitalManager2,
    Logger2,
    MessageManager,
    AdminManager2,
    MathValidator,
    CommandProcessor,
    BotStartupManager
};
