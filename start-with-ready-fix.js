/**
 * 使用ready事件修复启动WhatsApp机器人
 * 包含所有最新的ready事件修复和调试功能
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const bot = require('./bot.js');

console.log('🚀 WhatsApp资金管理机器人 2.0 - Ready事件修复版本');
console.log('🔧 修复内容:');
console.log('   - whatsapp-web.js@1.34.0 (包含PR #3747修复)');
console.log('   - 修复ready事件不触发问题');
console.log('   - 修复发送消息异常问题');
console.log('   - 添加30秒超时检测');
console.log('   - 增强调试信息');
console.log('');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'WhatsApp资金管理机器人 2.0 - Ready修复版',
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

    console.log('🔧 初始化机器人...');
    
    // 初始化机器人配置
    bot.init({ dataDir }).then(() => {
        console.log('✅ 机器人初始化完成');
        
        // 设置主窗口引用
        bot.setMainWindow(mainWindow);
        
        console.log('🌐 正在启动WhatsApp连接...');
        console.log('💡 提示: 请等待浏览器窗口打开并扫描二维码');
        console.log('⏳ 如果30秒内没有显示"机器人已就绪"，系统会自动重试\n');
        
        // 启动机器人逻辑
        bot.startBot();
    }).catch(error => {
        console.error('❌ 机器人初始化失败:', error);
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
}

// 应用启动时初始化
app.whenReady().then(() => {
    createWindow();
    
    // 确保logs目录存在
    const logsDir = path.join(__dirname, 'logs');
    if (!require('fs').existsSync(logsDir)) {
        require('fs').mkdirSync(logsDir, { recursive: true });
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

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('\n🛑 正在关闭机器人...');
    await bot.stopBot();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 正在关闭机器人...');
    await bot.stopBot();
    process.exit(0);
});
