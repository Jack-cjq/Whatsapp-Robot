const fs = require('fs');
const path = require('path');

// 日志配置
let logConfig = {
    console: {
        level: 'warn',
        enabled: true,
        filters: {
            messageReceived: false,
            messageSent: false,
            heartbeat: false,
            adminOperation: false,
            queueProcessing: false,
            chromeDetection: false,
            fileCreation: false,
            loadingProgress: false,
            qrCode: false
        }
    }
};

// 加载日志配置
function loadLogConfig() {
    try {
        const configPath = path.join(__dirname, '..', 'config', 'logging.json');
        if (fs.existsSync(configPath)) {
            logConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (error) {
        console.error('加载日志配置失败:', error);
    }
}

// 日志级别
const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};

// 智能日志输出
class SmartLogger {
    static init() {
        loadLogConfig();
    }

    static shouldLog(level, category = null) {
        if (!logConfig.console.enabled) return false;
        
        const currentLevel = LOG_LEVELS[logConfig.console.level] || 1;
        const messageLevel = LOG_LEVELS[level] || 1;
        
        if (messageLevel > currentLevel) return false;
        
        if (category && logConfig.console.filters[category] === false) {
            return false;
        }
        
        return true;
    }

    static error(message, ...args) {
        if (this.shouldLog('error')) {
            console.error(`❌ ${message}`, ...args);
        }
    }

    static warn(message, ...args) {
        if (this.shouldLog('warn')) {
            console.warn(`⚠️ ${message}`, ...args);
        }
    }

    static info(message, ...args) {
        if (this.shouldLog('info')) {
            console.log(`ℹ️ ${message}`, ...args);
        }
    }

    static debug(message, ...args) {
        if (this.shouldLog('debug')) {
            console.log(`🔍 ${message}`, ...args);
        }
    }

    // 特定类别的日志
    static messageReceived(message, ...args) {
        if (this.shouldLog('debug', 'messageReceived')) {
            console.log(`📨 ${message}`, ...args);
        }
    }

    static messageSent(message, ...args) {
        if (this.shouldLog('debug', 'messageSent')) {
            console.log(`📤 ${message}`, ...args);
        }
    }

    static heartbeat(message, ...args) {
        if (this.shouldLog('debug', 'heartbeat')) {
            console.log(`💓 ${message}`, ...args);
        }
    }

    static adminOperation(message, ...args) {
        if (this.shouldLog('info', 'adminOperation')) {
            console.log(`👤 ${message}`, ...args);
        }
    }

    static queueProcessing(message, ...args) {
        if (this.shouldLog('debug', 'queueProcessing')) {
            console.log(`📋 ${message}`, ...args);
        }
    }

    static chromeDetection(message, ...args) {
        if (this.shouldLog('info', 'chromeDetection')) {
            console.log(`🌐 ${message}`, ...args);
        }
    }

    static fileCreation(message, ...args) {
        if (this.shouldLog('info', 'fileCreation')) {
            console.log(`📁 ${message}`, ...args);
        }
    }

    static loadingProgress(message, ...args) {
        if (this.shouldLog('debug', 'loadingProgress')) {
            console.log(`⏳ ${message}`, ...args);
        }
    }

    static qrCode(message, ...args) {
        if (this.shouldLog('info', 'qrCode')) {
            console.log(`📱 ${message}`, ...args);
        }
    }

    // 系统级重要日志（总是显示）
    static system(message, ...args) {
        console.log(`🚀 ${message}`, ...args);
    }

    static success(message, ...args) {
        console.log(`✅ ${message}`, ...args);
    }

    static critical(message, ...args) {
        console.error(`🚨 ${message}`, ...args);
    }
}

module.exports = SmartLogger;
