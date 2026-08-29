'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const {
    classifyCommand,
    isSupportedBotCommand,
    MessageDeduper,
    ContactNameCache,
    FairGroupScheduler,
    AsyncLogger,
    OutboundMessageQueue,
    RuntimeMetrics,
    MemoryAccessControl,
    LatencyRegistry
} = require('./lib/runtime-core');
const { JsonCapitalStore } = require('./lib/json-capital-store');
const { CommandEngine } = require('./lib/command-engine');
const { DEFAULT_CONFIG, ConfigFileStore } = require('./lib/config-store');
const { createBotAdapters } = require('./lib/bot-adapters');
const {
    findEdgePath,
    findChromePath,
    listBrowserCandidates,
    prepareBrowserProfileDir,
    isBrowserLaunchError,
    buildPuppeteerConfig,
    sleep
} = require('./lib/browser-runtime');
const { createMessageIngressHandler } = require('./lib/message-ingress');
const { WhatsappBridgeWatchdog } = require('./lib/whatsapp-bridge-health');

if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
        console.log('✅ 控制台编码已设置为 UTF-8');
    } catch (error) {
        console.warn('⚠️ 无法切换控制台编码:', error.message);
    }
}

process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');
console.log('🚀 正在初始化 WhatsApp 机器人 2.0...');

let DATA_DIR = path.join(__dirname, 'data');
let CAPITAL_DATA_PATH = path.join(DATA_DIR, 'capital.json');
let CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let LOG_DIR = path.join(DATA_DIR, 'logs');
let BACKUP_DIR = path.join(DATA_DIR, 'backups');
let SESSION_DATA_PATH = DATA_DIR;
let runtimePathsRef = null;
let migrationBlocked = false;
let browserMissing = false;
let mainWindow = null;
let client = null;
let isConnected = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 5000;
let reconnectTimer = null;
let reconnectInFlight = false;
let shuttingDown = false;
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
const bridgeWatchdog = new WhatsappBridgeWatchdog({ intervalMs: 15000 });
const configStore = new ConfigFileStore({
    getFilePath: () => CONFIG_PATH,
    defaults: DEFAULT_CONFIG
});

class ConfigManager {
    static defaultConfig = DEFAULT_CONFIG;

    static getConfig() {
        return configStore.getConfig();
    }

    static saveConfig(configPatch) {
        const saved = configStore.savePatch(configPatch);
        this.hydrateAccessControl();
        return saved;
    }

    static reset() {
        configStore.reset();
    }

    static hydrateAccessControl() {
        const cfg = this.getConfig();
        accessControl.replaceAdmins(cfg.adminIds || []);
        accessControl.replaceAllowedGroups(cfg.allowedGroupIds || []);
        if (cfg.maxConcurrentGroups !== undefined) {
            groupCommandScheduler.maxConcurrentGroups = cfg.maxConcurrentGroups;
        }
    }
}

const {
    Logger2,
    CapitalManager2,
    MessageManager,
    AdminManager2,
    MathValidator,
    CommandProcessor
} = createBotAdapters({
    asyncLogger,
    capitalStore,
    outboundQueue,
    getMessageStats: () => messageStats,
    getConfig: () => ConfigManager.getConfig(),
    accessControl,
    getCommandEngine: () => commandEngine
});

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
        backupDir: BACKUP_DIR,
        getMaxHistory: () => ConfigManager.getConfig().maxHistoryRecords || 1000,
        isAutoBackupEnabled: () => ConfigManager.getConfig().autoBackup === true,
        getBackupIntervalHours: () => ConfigManager.getConfig().backupInterval,
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
    if (!config) return;
    runtimePathsRef = config;

    if (config.dataDir) DATA_DIR = config.dataDir;
    if (config.capitalPath) CAPITAL_DATA_PATH = config.capitalPath;
    else if (config.dataDir) CAPITAL_DATA_PATH = path.join(config.dataDir, 'capital.json');

    if (config.configPath) CONFIG_PATH = config.configPath;
    else if (config.configDir) CONFIG_PATH = path.join(config.configDir, 'config.json');
    else if (config.dataDir) CONFIG_PATH = path.join(config.dataDir, 'config.json');

    if (config.logsDir) LOG_DIR = config.logsDir;
    else if (config.dataDir) LOG_DIR = path.join(config.dataDir, 'logs');

    if (config.backupDir) BACKUP_DIR = config.backupDir;
    else if (config.dataDir) BACKUP_DIR = path.join(config.dataDir, 'backups');

    if (config.sessionDataPath) SESSION_DATA_PATH = config.sessionDataPath;
    else SESSION_DATA_PATH = DATA_DIR;

    if (config.migrationBlocked) migrationBlocked = true;
    ConfigManager.reset();

    [DATA_DIR, LOG_DIR, BACKUP_DIR, path.dirname(CONFIG_PATH)].forEach((dir) => {
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
    if (!fs.existsSync(CONFIG_PATH)) {
        ConfigManager.saveConfig(ConfigManager.defaultConfig);
    }
    ConfigManager.hydrateAccessControl();
}

function setMigrationBlocked(blocked, reason) {
    migrationBlocked = !!blocked;
    if (blocked) {
        console.error('❌ 数据迁移失败，资金写入已禁用:', reason || '');
        Logger2.error(new Error(reason || 'migration failed'), { context: 'migration' });
    }
}

function getRuntimePaths() {
    return runtimePathsRef;
}

function getBrowserStatus() {
    return {
        edge: findEdgePath(),
        chrome: findChromePath(),
        missing: browserMissing
    };
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

            if (migrationBlocked) {
                throw new Error('数据迁移失败，请检查用户数据目录与旧 data，修复后再启动');
            }

            await this.performEnvironmentCheck();
            this.updateProgress(1);

            await this.validateConfiguration();
            this.updateProgress(2);

            await ensureCapitalStack();
            this.updateProgress(3);

            await this.launchWhatsAppWithRetry();
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

    /**
     * 首次启动 Edge/Chrome 偶发 “Failed to launch … Code: 0”
     * 清理锁文件后重试，并在 Edge 失败时回退 Chrome。
     */
    static async launchWhatsAppWithRetry() {
        const browsers = listBrowserCandidates();
        browserMissing = browsers.length === 0;
        if (browserMissing) {
            throw new Error('未检测到 Microsoft Edge 或 Google Chrome，请安装后再启动');
        }

        let lastError = null;
        for (let bi = 0; bi < browsers.length; bi++) {
            const browserPath = browsers[bi];
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    console.log(
                        `🔧 启动浏览器 (${bi + 1}/${browsers.length}) 尝试 ${attempt}/3: ${browserPath}`
                    );
                    prepareBrowserProfileDir(SESSION_DATA_PATH);
                    await this.initializeClient(browserPath);
                    this.updateProgress(4);
                    this.setupEventListeners();
                    this.updateProgress(5);
                    await this.startClient();
                    console.log('✅ WhatsApp 浏览器已启动:', browserPath);
                    return;
                } catch (error) {
                    lastError = error;
                    console.warn(`⚠️ 浏览器启动失败: ${error.message}`);
                    try {
                        if (client) await client.destroy();
                    } catch (destroyError) {
                        console.warn('⚠️ 清理启动失败的客户端时出错:', destroyError.message);
                    }
                    client = null;
                    isConnected = false;

                    if (!isBrowserLaunchError(error)) {
                        throw error;
                    }
                    prepareBrowserProfileDir(SESSION_DATA_PATH);
                    await sleep(800 * attempt);
                }
            }
            console.warn('⚠️ 当前浏览器连续失败，尝试下一个候选…');
        }

        const detail = lastError ? lastError.message : 'unknown';
        throw new Error(
            `无法启动用于 WhatsApp 的浏览器（已重试 Edge/Chrome）。${detail}`
        );
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

    static async initializeClient(browserPath) {
        console.log('🔧 初始化客户端...', browserPath || '');
        const resolvedPath = browserPath || listBrowserCandidates()[0] || null;
        browserMissing = !resolvedPath;
        if (browserMissing) {
            console.error('❌ 未找到 Microsoft Edge 或 Google Chrome，WhatsApp 无法启动浏览器');
            if (mainWindow && !mainWindow.isDestroyed()) {
                try {
                    mainWindow.webContents.send('browser-missing', {
                        message: '未检测到 Microsoft Edge 或 Google Chrome，请安装后再启动'
                    });
                } catch (notifyError) {
                    console.warn('⚠️ 无法向界面发送浏览器缺失提示:', notifyError.message);
                }
            }
        } else {
            console.log('✅ 使用浏览器:', resolvedPath);
        }

        prepareBrowserProfileDir(SESSION_DATA_PATH);
        const puppeteerConfig = buildPuppeteerConfig(resolvedPath);

        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: SESSION_DATA_PATH,
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

        // 极轻量回调：无 await / 无 Puppeteer / 无 fs / 不持有 Message 实例
        client.on(
            'message',
            createMessageIngressHandler({
                messageStats,
                messageDeduper,
                groupCommandScheduler,
                latencyRegistry,
                logger: Logger2,
                getRuntimeState: () => ({ isConnected, capitalReady, commandEngine })
            })
        );

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
            reconnectInFlight = false;
            lastHeartbeat = Date.now();
            this.currentState = this.startupStates.READY;
            try {
                const wwebVersion = await client.getWWebVersion();
                console.log(`📱 WhatsApp Web 版本: ${wwebVersion}`);
            } catch (error) {
                console.warn('无法读取 WhatsApp Web 版本:', error.message);
            }
            startHeartbeat();
            outboundQueue.resume().catch((error) => {
                Logger2.error(error, { context: 'outbound_resume_after_ready' });
            });
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
            } catch (notifyError) {
                console.warn('⚠️ 无法向界面发送启动进度:', notifyError.message);
            }
        }
    }
}

function startBot() {
    shuttingDown = false;
    return BotStartupManager.startBot();
}

async function handleDisconnection(reason) {
    console.log(`🔌 处理断开连接: ${reason}`);
    if (shuttingDown || reconnectTimer || reconnectInFlight) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error('❌ 达到最大重连次数，停止重连');
        return;
    }
    reconnectAttempts++;
    const delay = reconnectDelay * reconnectAttempts;
    console.log(`🔄 ${reconnectAttempts}/${maxReconnectAttempts}，${delay}ms 后重建客户端...`);
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        reconnectInFlight = true;
        try {
            if (client) {
                try {
                    await client.destroy();
                } catch (error) {
                    console.warn('重连前关闭旧客户端失败:', error.message);
                }
            }
            await BotStartupManager.initializeClient();
            BotStartupManager.setupEventListeners();
            await BotStartupManager.startClient();
        } catch (error) {
            console.error('❌ 重连失败:', error);
            reconnectInFlight = false;
            await handleDisconnection(reason);
            return;
        }
        reconnectInFlight = false;
    }, delay);
}

function startHeartbeat() {
    console.log('💓 启动 WhatsApp 消息桥接健康检查...');
    bridgeWatchdog.start({
        getClient: () => client,
        isConnected: () => isConnected,
        onHealthy: () => {
            lastHeartbeat = Date.now();
        },
        onUnhealthy: async (error) => {
            Logger2.error(error, {
                context: 'whatsapp_bridge_watchdog',
                code: error.code,
                bridgeState: error.bridgeState
            });
            isConnected = false;
            BotStartupManager.currentState = BotStartupManager.startupStates.ERROR;
            stopHeartbeat();
            await handleDisconnection('message_bridge_lost');
        }
    });
}

function stopHeartbeat() {
    if (bridgeWatchdog.stop()) console.log('💓 WhatsApp 消息桥接健康检查已停止');
}

function getConnectionStatus() {
    const startedAt = BotStartupManager.startupStartTime || Date.now();
    return {
        isConnected,
        reconnectAttempts,
        lastHeartbeat,
        uptime: Math.max(0, Date.now() - startedAt)
    };
}

function getMessageStats() {
    return messageStats;
}

function setMainWindow(window) {
    mainWindow = window;
}

async function flushAndShutdown() {
    shuttingDown = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    const deadline = Date.now() + 20000;
    try {
        capitalReady = false;
        await outboundQueue.drain(Math.max(1000, deadline - Date.now()));
    } catch (error) {
        console.warn('⚠️ 关闭时等待出站队列失败:', error.message);
    }
    try {
        await capitalStore.flush();
    } catch (error) {
        console.warn('⚠️ 关闭时刷新账本失败:', error.message);
    }
    try {
        await Logger2.flush();
        await asyncLogger.close();
    } catch (error) {
        console.warn('⚠️ 关闭时刷新日志失败:', error.message);
    }
    try {
        await capitalStore.close();
    } catch (error) {
        console.warn('⚠️ 关闭账本存储失败:', error.message);
    }
    try {
        if (client) {
            await Promise.race([
                client.destroy(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('destroy timeout')), 8000))
            ]);
        }
    } catch (e) {
        console.warn('关闭 WhatsApp 客户端:', e.message);
    }
    client = null;
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
    setMigrationBlocked,
    getRuntimePaths,
    getBrowserStatus,
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
