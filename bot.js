'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const math = require('mathjs');
const moment = require('moment');
const _ = require('lodash');
const {
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
    normalizeId
} = require('./lib/runtime-core');
const { JsonCapitalStore } = require('./lib/json-capital-store');
const { CommandEngine } = require('./lib/command-engine');

if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
        console.log('✅ 控制台编码已设置为 UTF-8');
    } catch (_) {}
}

process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');
console.log('🚀 正在初始化 WhatsApp 机器人 2.0...');

let DATA_DIR = path.join(__dirname, 'data');
let CAPITAL_DATA_PATH = path.join(DATA_DIR, 'capital.json');
let CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let LOG_DIR = path.join(DATA_DIR, 'logs');
let mainWindow = null;
let client = null;
let isConnected = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 5000;
let heartbeatInterval = null;
let lastHeartbeat = Date.now();
let metricsTimerStarted = false;
let capitalReady = false;
let commandEngine = null;

let messageStats = {
    totalMessages: 0,
    processedMessages: 0,
    failedMessages: 0,
    lastReset: Date.now()
};

const capitalStore = new JsonCapitalStore();
const asyncLogger = new AsyncLogger();
const messageDeduper = new MessageDeduper({ ttlMs: 10 * 60 * 1000, maxSize: 5000 });
const groupCommandScheduler = new FairGroupScheduler({
    maxConcurrentGroups: 8,
    warnDepth: 500,
    hardLimit: 50000
});
const outboundQueue = new OutboundMessageQueue();
const runtimeMetrics = new RuntimeMetrics();
const accessControl = new MemoryAccessControl();
const contactCache = new ContactNameCache();
const latencyRegistry = new LatencyRegistry();

class ConfigManager {
    static defaultConfig = {
        version: '2.0.0',
        adminIds: ['你的用户名'],
        allowedGroupIds: [],
        maxConcurrentGroups: 8,
        autoBackup: true,
        backupInterval: 24,
        maxHistoryRecords: 1000,
        cleanupDays: 30,
        enableNotifications: true,
        language: 'zh-CN',
        theme: 'default'
    };

    static cache = null;

    static getConfig() {
        if (this.cache) return this.cache;
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
                this.cache = _.merge({}, this.defaultConfig, config);
                return this.cache;
            }
        } catch (error) {
            console.error('读取配置文件失败:', error);
        }
        this.cache = { ...this.defaultConfig };
        return this.cache;
    }

    static saveConfig(config) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
            this.cache = _.merge({}, this.defaultConfig, config);
            this.hydrateAccessControl();
            return true;
        } catch (error) {
            console.error('保存配置文件失败:', error);
            return false;
        }
    }

    static hydrateAccessControl() {
        const cfg = this.getConfig();
        accessControl.replaceAdmins(cfg.adminIds || []);
        accessControl.replaceAllowedGroups(cfg.allowedGroupIds || []);
        if (cfg.maxConcurrentGroups) {
            groupCommandScheduler.maxConcurrentGroups = cfg.maxConcurrentGroups;
        }
    }
}

class Logger2 {
    static write(d) { asyncLogger.write(d); }
    static system(e, d) { asyncLogger.system(e, d); }
    static operation(g, a, u, c) { asyncLogger.operation(g, a, u, c); }
    static error(e, c) { asyncLogger.error(e, c); }
    static warn(m, c) { asyncLogger.warn(m, c); }
    static info(e, d) { asyncLogger.info(e, d); }
    static debug(e, d) { asyncLogger.debug(e, d); }
    static async flush() { return asyncLogger.flush(); }
}

class CapitalManager2 {
    static async getCapital(groupId) {
        const q = await capitalStore.query(groupId, 1);
        return {
            capital: q.balance || 0,
            history: q.history || [],
            statistics: { totalOperations: ((q.history || []).length) }
        };
    }

    static async getHistory(groupId, limit = 10) {
        const q = await capitalStore.query(groupId, limit);
        return q.history || [];
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
        return messageStats;
    }

    static getQueueStatus() {
        return outboundQueue.getQueueStatus();
    }
}

class AdminManager2 {
    static getAdminList() {
        return ConfigManager.getConfig().adminIds || [];
    }

    static isAdmin(userName, userId) {
        if (accessControl.isAdmin(userId, userName)) return true;
        const adminList = this.getAdminList();
        if (!adminList.length) return false;
        const nName = normalizeId(userName).toLowerCase();
        const nId = normalizeId(userId).toLowerCase();
        return adminList.some((admin) => {
            const nAdmin = normalizeId(admin).toLowerCase();
            return admin === userName || admin === userId || nAdmin === nName || nAdmin === nId;
        });
    }
}

class MathValidator {
    static validateExpression(expression) {
        const dangerousFunctions = ['eval', 'Function', 'constructor', 'prototype'];
        if (dangerousFunctions.some((func) => expression.includes(func))) {
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
        if (!isFinite(result)) throw new Error('计算结果无效');
        return parseFloat(result.toFixed(4));
    }
}

class CommandProcessor {
    static async handleCommand(chat, message, userInfo) {
        const groupId = typeof chat === 'string' ? chat : chat.id._serialized;
        const text = (message && message.body ? message.body : '').trim();
        const classified = classifyCommand(text);
        if (classified.type === CMD.IGNORE) return;
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
        return commandEngine.handle(dto, classified);
    }

    static isMathExpression(text) {
        return isMathExpression(text);
    }
}

function findEdgePath() {
    const possiblePaths = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log('✅ 找到Edge浏览器:', p);
            return p;
        }
    }
    return null;
}

function findChromePath() {
    const possiblePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log('✅ 找到Chrome浏览器:', p);
            return p;
        }
    }
    return null;
}

function startRuntimeMetricsIfNeeded() {
    if (metricsTimerStarted) return;
    metricsTimerStarted = true;
    runtimeMetrics.start(() => ({
        incomingQueueLength: groupCommandScheduler.incomingQueueLength,
        activeGroups: groupCommandScheduler.activeGroups,
        outputQueueLength: outboundQueue.length,
        logQueueLength: asyncLogger.getQueueLength(),
        persistStatus: capitalStore.getStatus(),
        processedCount: groupCommandScheduler.processedCount,
        failedCount: groupCommandScheduler.failedCount,
        duplicateCount: messageDeduper.duplicateCount,
        droppedNonCommandCount: groupCommandScheduler.droppedNonCommandCount,
        latency: latencyRegistry.snapshotAll()
    }));
}

async function ensureCapitalStack() {
    ConfigManager.hydrateAccessControl();
    asyncLogger.configure({
        logDir: LOG_DIR,
        getMainWindow: () => mainWindow,
        isWindowVisible: () => {
            try {
                return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
            } catch (_) {
                return true;
            }
        }
    });
    outboundQueue.configure({
        sendFn: async (chatId, message, options) => {
            if (!client) throw new Error('client not ready');
            return client.sendMessage(chatId, message, { sendSeen: false, ...options });
        },
        isConnectedFn: () => isConnected,
        onProcessed: () => {
            messageStats.processedMessages++;
        },
        onFailed: () => {
            messageStats.failedMessages++;
        }
    });

    capitalStore.configure({
        filePath: CAPITAL_DATA_PATH,
        backupDir: path.join(DATA_DIR, 'backups'),
        getMaxHistory: () => ConfigManager.getConfig().maxHistoryRecords || 1000,
        mergeWaitMs: 3,
        latency: latencyRegistry
    });
    await capitalStore.load();
    capitalReady = true;

    commandEngine = new CommandEngine({
        capitalStore,
        accessControl,
        outbound: outboundQueue,
        logger: Logger2,
        contactCache,
        latency: latencyRegistry,
        mathValidator: MathValidator
    });

    startRuntimeMetricsIfNeeded();
}

function init(config) {
    if (config && config.dataDir) {
        DATA_DIR = config.dataDir;
        CAPITAL_DATA_PATH = path.join(DATA_DIR, 'capital.json');
        CONFIG_PATH = path.join(DATA_DIR, 'config.json');
        LOG_DIR = path.join(DATA_DIR, 'logs');
    }
    [DATA_DIR, LOG_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
    if (!fs.existsSync(CONFIG_PATH)) {
        ConfigManager.saveConfig(ConfigManager.defaultConfig);
    }
    ConfigManager.hydrateAccessControl();
}

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
        '数据库初始化',
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

            await this.performEnvironmentCheck();
            this.updateProgress(1);

            await this.validateConfiguration();
            this.updateProgress(2);

            await ensureCapitalStack();
            this.updateProgress(3);

            await this.initializeClient();
            this.updateProgress(4);

            this.setupEventListeners();
            this.updateProgress(5);

            await this.startClient();
            this.updateProgress(6);

            this.startHeartbeat();
            this.updateProgress(7);

            this.completeStartup();
            this.updateProgress(8);

            Logger2.system('BOT_STARTUP_SUCCESS', {
                duration: Date.now() - this.startupStartTime
            });
        } catch (error) {
            await this.handleStartupError(error);
        }
    }

    static async performEnvironmentCheck() {
        console.log('🔍 执行环境检查...');
        [DATA_DIR, LOG_DIR].forEach((dir) => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log('✅ 创建目录:', dir);
            }
        });
        if (!fs.existsSync(CONFIG_PATH)) {
            ConfigManager.saveConfig(ConfigManager.defaultConfig);
        }
        console.log('✅ 环境检查完成');
    }

    static async validateConfiguration() {
        console.log('⚙️ 验证配置...');
        const config = ConfigManager.getConfig();
        ConfigManager.hydrateAccessControl();
        console.log(`✅ 管理员配置: ${(config.adminIds || []).length} 个管理员`);
        console.log(`✅ capital.json 模式, maxConcurrentGroups=${groupCommandScheduler.maxConcurrentGroups}`);
    }

    static async initializeClient() {
        console.log('🔧 初始化客户端...');
        const chromePath = findChromePath();
        const edgePath = !chromePath ? findEdgePath() : null;
        const browserPath = chromePath || edgePath;
        const puppeteerConfig = {
            headless: false,
            executablePath: browserPath || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--no-first-run',
                '--window-size=1280,720'
            ],
            timeout: 120000,
            protocolTimeout: 120000
        };

        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: DATA_DIR,
                clientId: 'whatsapp-bot-v2'
            }),
            puppeteer: puppeteerConfig,
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0
        });

        const rawSendMessage = client.sendMessage.bind(client);
        client.sendMessage = (chatId, content, options = {}) =>
            rawSendMessage(chatId, content, { sendSeen: false, ...options });

        outboundQueue.configure({
            sendFn: async (chatId, message, options) =>
                client.sendMessage(chatId, message, { sendSeen: false, ...options }),
            isConnectedFn: () => isConnected,
            onProcessed: () => {
                messageStats.processedMessages++;
            },
            onFailed: () => {
                messageStats.failedMessages++;
            }
        });

        console.log('✅ 客户端初始化完成');
    }

    static setupEventListeners() {
        console.log('👂 设置事件监听器...');

        // 极轻量回调：无 await / 无 Puppeteer / 无 fs / 不持有 msg
        client.on('message', (msg) => {
            const receivedAtNs = process.hrtime.bigint();
            try {
                messageStats.totalMessages++;
                if (msg.fromMe) return;

                const messageId = msg.id && msg.id._serialized ? msg.id._serialized : null;
                const chatId = msg.from;
                const senderId = msg.author || msg.from;
                const body = typeof msg.body === 'string' ? msg.body : '';
                const type = msg.type;
                const timestamp = msg.timestamp;
                // 同步读取推送名（不调用 getContact），用于管理员名称匹配
                const notifyName =
                    (msg._data && (msg._data.notifyName || msg._data.notify)) || '';

                if (!chatId || typeof chatId !== 'string') return;
                if (messageDeduper.isDuplicate(messageId)) return;

                const classified = classifyCommand(body);
                if (classified.type === CMD.IGNORE) {
                    groupCommandScheduler.droppedNonCommandCount++;
                    return;
                }

                if (!isConnected || !capitalReady || !commandEngine) return;

                const dto = Object.freeze({
                    messageId,
                    chatId,
                    senderId,
                    notifyName: typeof notifyName === 'string' ? notifyName : '',
                    body,
                    type,
                    timestamp,
                    receivedAtNs,
                    isGroup: chatId.endsWith('@g.us')
                });

                const enqueuedAtNs = process.hrtime.bigint();
                latencyRegistry.record(
                    'receiveToEnqueueMs',
                    LatencyRegistry.nsToMs(receivedAtNs, enqueuedAtNs)
                );

                const ok = groupCommandScheduler.enqueue(dto.chatId, {
                    enqueuedAtNs,
                    run: async () => {
                        const result = await commandEngine.handle(dto, classified);
                        const localTotalMs = LatencyRegistry.nsToMs(dto.receivedAtNs);
                        latencyRegistry.record('localTotalMs', localTotalMs);
                        latencyRegistry.record('endToEndObservedMs', localTotalMs);
                        return result;
                    }
                });
                if (!ok) Logger2.warn('OVERLOAD_REJECT', { chatId });
            } catch (error) {
                Logger2.error(error, { context: 'message_preprocessor' });
            }
        });

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
            Logger2.system('DISCONNECTED', { reason });
        });

        client.on('qr', (qr) => {
            console.log('📱 请扫描二维码登录 WhatsApp');
            qrcode.generate(qr, { small: true });
            this.currentState = this.startupStates.AUTHENTICATING;
        });

        client.on('loading_screen', (percent, message) => {
            console.log(`⏳ 加载中: ${percent}% - ${message}`);
        });

        client.on('authenticated', () => {
            console.log('🔐 WhatsApp 身份验证成功');
            Logger2.system('AUTHENTICATED', {});
        });

        client.on('ready', async () => {
            console.log('✅ WhatsApp 客户端已准备就绪');
            isConnected = true;
            reconnectAttempts = 0;
            this.currentState = this.startupStates.READY;
            try {
                const wwebVersion = await client.getWWebVersion();
                console.log(`📱 WhatsApp Web 版本: ${wwebVersion}`);
            } catch (_) {}
            console.log('🤖 机器人现在可以接收和处理消息了！');
            Logger2.system('CLIENT_READY', {});
        });

        console.log('✅ 事件监听器设置完成');
    }

    static async startClient() {
        console.log('🚀 启动客户端...');
        this.currentState = this.startupStates.CONNECTING;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('客户端启动超时')), 120000);
            client
                .initialize()
                .then(() => {
                    clearTimeout(timeout);
                    resolve();
                })
                .catch((error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    }

    static startHeartbeat() {
        startHeartbeat();
    }

    static completeStartup() {
        const duration = Date.now() - this.startupStartTime;
        console.log(`🎉 机器人启动流程完成！耗时: ${duration}ms`);
        console.log('⏳ 等待 WhatsApp 连接建立...');
    }

    static async handleStartupError(error) {
        console.error('❌ 机器人启动失败:', error.message);
        this.currentState = this.startupStates.ERROR;
        Logger2.error(error, { context: 'bot_startup' });
        isConnected = false;
        stopHeartbeat();
        throw error;
    }

    static updateProgress(step) {
        this.startupProgress = step;
        const progress = Math.round((step / this.startupSteps.length) * 100);
        console.log(`📈 启动进度: ${progress}% - ${this.startupSteps[step - 1]}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('startup-progress', {
                    step,
                    progress,
                    currentStep: this.startupSteps[step - 1],
                    totalSteps: this.startupSteps.length
                });
            } catch (_) {}
        }
    }
}

function startBot() {
    return BotStartupManager.startBot();
}

async function handleDisconnection(reason) {
    console.log(`🔌 处理断开连接: ${reason}`);
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error('❌ 达到最大重连次数，停止重连');
        return;
    }
    reconnectAttempts++;
    const delay = reconnectDelay * reconnectAttempts;
    console.log(`🔄 ${reconnectAttempts}/${maxReconnectAttempts}，${delay}ms 后重建客户端...`);
    setTimeout(async () => {
        try {
            if (client) {
                try {
                    await client.destroy();
                } catch (_) {}
            }
            await BotStartupManager.initializeClient();
            BotStartupManager.setupEventListeners();
            await BotStartupManager.startClient();
        } catch (error) {
            console.error('❌ 重连失败:', error);
            handleDisconnection(reason);
        }
    }, delay);
}

function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    console.log('💓 启动心跳机制...');
    heartbeatInterval = setInterval(() => {
        try {
            if (client && isConnected) lastHeartbeat = Date.now();
        } catch (error) {
            console.error('💔 心跳检测失败:', error);
            isConnected = false;
            handleDisconnection('heartbeat_failed');
        }
    }, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log('💓 心跳机制已停止');
    }
}

function getConnectionStatus() {
    return {
        isConnected,
        reconnectAttempts,
        lastHeartbeat,
        uptime: Date.now() - lastHeartbeat
    };
}

function getMessageStats() {
    return messageStats;
}

function setMainWindow(window) {
    mainWindow = window;
}

async function flushAndShutdown() {
    try {
        await outboundQueue.drain(10000);
    } catch (_) {}
    try {
        await capitalStore.flush();
    } catch (_) {}
    try {
        await Logger2.flush();
        await asyncLogger.close();
    } catch (_) {}
    try {
        await capitalStore.close();
    } catch (_) {}
    capitalReady = false;
    runtimeMetrics.stop();
    stopHeartbeat();
}

module.exports = {
    init,
    startBot,
    setMainWindow,
    getConnectionStatus,
    getMessageStats,
    flushAndShutdown,
    ConfigManager,
    CapitalManager2,
    Logger2,
    MessageManager,
    AdminManager2,
    MathValidator,
    CommandProcessor,
    BotStartupManager,
    classifyCommand,
    isSupportedBotCommand,
    groupCommandScheduler,
    messageDeduper,
    capitalStore,
    asyncLogger,
    outboundQueue,
    accessControl,
    latencyRegistry,
    ensureCapitalStack
};
