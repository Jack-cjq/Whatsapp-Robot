const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 控制台编码设置
if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
            // console.log('✅ 控制台编码已设置为 UTF-8');
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

    // console.log('✅ Electron窗口已创建');
}

// 应用启动时初始化
app.whenReady().then(() => {
    createWindow();
    // console.log('🎉 WhatsApp资金管理机器人 2.0 界面已启动');
    // console.log('📝 注意: 这是一个演示版本，WhatsApp连接功能已禁用');
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

// IPC 通信处理 - 简化版本
ipcMain.handle('request-logs', async (event) => {
    return [
        '[12:00:00] [SYSTEM] WhatsApp资金管理机器人 2.0 已启动',
        '[12:00:01] [SYSTEM] 演示模式 - WhatsApp连接已禁用',
        '[12:00:02] [SYSTEM] 界面初始化完成',
        '[12:00:03] [INFO] 这是一个演示版本，用于展示界面功能'
    ];
});

// 演示模式配置存储
let demoConfig = {
    adminIds: ['演示管理员', 'Tongyang'],
    maxHistoryRecords: 1000,
    autoBackup: true,
    backupInterval: 24,
    enableNotifications: true
};

ipcMain.handle('request-config', async (event) => {
    return demoConfig;
});

ipcMain.handle('update-config', async (event, configUpdates) => {
    // console.log('配置更新:', configUpdates);
    demoConfig = { ...demoConfig, ...configUpdates };
    return { success: true };
});

ipcMain.handle('update-config', async (event, configUpdates) => {
    // console.log('配置更新:', configUpdates);
    return { success: true };
});

ipcMain.handle('export-data', async (event, groupId) => {
    return { success: true, path: '演示数据导出路径' };
});

// 群组数据请求处理 - 演示版本
ipcMain.handle('request-group-data', async (event) => {
    return {
        activeGroups: 2,
        totalOperations: 15
    };
});

// 消息统计请求处理 - 演示版本
ipcMain.handle('request-message-stats', async (event) => {
    return {
        totalMessages: 42,
        processedMessages: 40,
        failedMessages: 2,
        lastReset: Date.now()
    };
});

// 连接状态请求处理 - 演示版本
ipcMain.handle('request-connection-status', async (event) => {
    return {
        isConnected: true,
        reconnectAttempts: 0,
        lastHeartbeat: Date.now(),
        uptime: 3600000 // 1小时
    };
});

// 队列状态请求处理 - 演示版本
ipcMain.handle('request-queue-status', async (event) => {
    return {
        queueLength: 3,
        isProcessing: false,
        sendingMessages: 0
    };
});

// console.log('🚀 正在启动 WhatsApp资金管理机器人 2.0 演示版本...');
