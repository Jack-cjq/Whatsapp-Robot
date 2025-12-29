const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const bot = require('./bot.js');

// 控制台编码设置
if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
            // console.log('✅ 主进程控制台编码已设置为 UTF-8');
} catch (error) {
    // console.log('⚠️ 设置控制台编码失败，但不影响程序运行');
}
}

process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'WhatsApp资金管理机器人 2.0',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.ico')
    });

    // 动态计算数据目录
    const isPackaged = app.isPackaged;
    const userDataPath = app.getPath('userData');
    const dataDir = isPackaged 
        ? path.join(userDataPath, 'data') 
        : path.join(__dirname, 'data');

    // 初始化机器人配置
    bot.init({ dataDir });

    // 设置主窗口引用
    bot.setMainWindow(mainWindow);

    // 启动机器人逻辑
    bot.startBot();

    // 加载前端界面
    mainWindow.loadFile('index.html');

    // 开发模式下打开开发者工具
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    // 关闭事件处理
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 应用启动时初始化
app.whenReady().then(() => {
    createWindow();
    
    // 确保logs目录存在
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
        // console.log('✅ 创建日志目录:', logsDir);
    }
});

// 当所有窗口关闭时退出应用
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// IPC 通信处理
ipcMain.handle('request-logs', async (event) => {
    try {
        const logDate = new Date().toISOString().split('T')[0];
        const logPath = path.join(__dirname, 'data', 'logs', `${logDate}.log`);
        
        if (!fs.existsSync(logPath)) {
            return ['暂无日志数据'];
        }
        
        const logs = fs.readFileSync(logPath, 'utf8').split('\n');
        const filteredLogs = logs.filter(line => line.trim() !== '');
        
        const readableLogs = filteredLogs.map(line => {
            try {
                const logData = JSON.parse(line);
                const time = new Date(logData.timestamp).toLocaleTimeString();
                return `[${time}] [${logData.type}] ${logData.event || logData.action || '未知操作'}`;
            } catch (e) {
                return line;
            }
        });
        
        return readableLogs;
    } catch (error) {
        console.error('读取日志失败:', error);
        return ['读取日志失败'];
    }
});

ipcMain.handle('request-config', async (event) => {
    try {
        const config = bot.ConfigManager.getConfig();
        return config;
    } catch (error) {
        console.error('读取配置失败:', error);
        return null;
    }
});

ipcMain.handle('update-config', async (event, configUpdates) => {
    try {
        const success = bot.ConfigManager.saveConfig(configUpdates);
        if (success) {
            return { success: true };
        } else {
            return { success: false, error: '保存配置失败' };
        }
    } catch (error) {
        console.error('更新配置失败:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('export-data', async (event, groupId) => {
    try {
        const data = bot.CapitalManager2.getData();
        const exportPath = path.join(__dirname, 'data', `export_${groupId}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        
        fs.writeFileSync(exportPath, JSON.stringify(data, null, 2));
        return { success: true, path: exportPath };
    } catch (error) {
        console.error('导出数据失败:', error);
        return { success: false, error: error.message };
    }
});

// 群组数据请求处理
ipcMain.handle('request-group-data', async (event) => {
    try {
        const data = bot.CapitalManager2.getData();
        
        // 过滤掉系统字段，只保留群组数据
        const groups = {};
        let totalOperations = 0;
        
        Object.keys(data).forEach(key => {
            if (key !== '_description' && key !== '_adminIds') {
                const groupData = data[key];
                if (groupData && typeof groupData === 'object' && groupData.capital !== undefined) {
                    groups[key] = {
                        operations: groupData.statistics ? groupData.statistics.totalOperations || 0 : 0
                    };
                    totalOperations += groups[key].operations;
                }
            }
        });
        
        const activeGroups = Object.keys(groups).length;
        
        return {
            activeGroups,
            totalOperations
        };
    } catch (error) {
        console.error('读取群组数据失败:', error);
        return {
            activeGroups: 0,
            totalOperations: 0
        };
    }
});

// 消息统计请求处理
ipcMain.handle('request-message-stats', async (event) => {
    try {
        // 从机器人获取消息处理统计
        const stats = bot.getMessageStats();
        return stats;
    } catch (error) {
        console.error('读取消息统计失败:', error);
        return {
            totalMessages: 0,
            processedMessages: 0,
            failedMessages: 0,
            lastReset: Date.now()
        };
    }
});

// 连接状态请求处理
ipcMain.handle('request-connection-status', async (event) => {
    try {
        const status = bot.getConnectionStatus();
        return status;
    } catch (error) {
        console.error('读取连接状态失败:', error);
        return {
            isConnected: false,
            reconnectAttempts: 0,
            lastHeartbeat: Date.now(),
            uptime: 0
        };
    }
});

// 消息队列状态请求处理
ipcMain.handle('request-queue-status', async (event) => {
    try {
        const queueStatus = bot.MessageManager.getQueueStatus();
        return queueStatus;
    } catch (error) {
        console.error('读取队列状态失败:', error);
        return {
            queueLength: 0,
            isProcessing: false,
            sendingMessages: 0
        };
    }
});
