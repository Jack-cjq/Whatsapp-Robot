// 全局变量
let currentTab = 'dashboard';
let logs = [];
let config = {};

// DOM 加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

// 初始化应用
function initializeApp() {
    setupTabNavigation();
    setupEventListeners();
    loadInitialData();
    startStatusUpdates();
}

// 设置标签页导航
function setupTabNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');
            switchTab(targetTab);
        });
    });
}

// 切换标签页
function switchTab(tabName) {
    // 更新导航按钮状态
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // 更新内容区域
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName).classList.add('active');

    currentTab = tabName;

    // 根据标签页加载相应数据
    switch(tabName) {
        case 'logs':
            loadLogs();
            break;
        case 'config':
            loadConfig();
            break;
        case 'dashboard':
            updateDashboard();
            break;
    }
}

// 设置事件监听器
function setupEventListeners() {
    // 日志更新监听
    if (window.electronAPI && window.electronAPI.onLogUpdate) {
        window.electronAPI.onLogUpdate((event, logText) => {
            addLogEntry(logText);
        });
    }

    // 配置更新监听
    if (window.electronAPI && window.electronAPI.onConfigUpdated) {
        window.electronAPI.onConfigUpdated((event, result) => {
            if (result.success) {
                showNotification('配置保存成功', 'success');
            } else {
                showNotification('配置保存失败: ' + result.error, 'error');
            }
        });
    }
}

// 加载初始数据
function loadInitialData() {
    updateDashboard();
    loadConfig();
}

// 更新仪表板
function updateDashboard() {
    // 更新状态
    updateConnectionStatus();
    updateUptime();
    updateMessageCount();
    updateAdminCount();
    updateGroupManagement();
    updateQueueStatus();
}

// 更新连接状态
async function updateConnectionStatus() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const connectionStatus = document.getElementById('connectionStatus');

    try {
        if (window.electronAPI && window.electronAPI.requestConnectionStatus) {
            const status = await window.electronAPI.requestConnectionStatus();
            
            if (status.isConnected) {
                statusDot.classList.add('connected');
                statusDot.classList.remove('disconnected');
                statusText.textContent = '已连接';
                connectionStatus.textContent = '在线';
            } else {
                statusDot.classList.remove('connected');
                statusDot.classList.add('disconnected');
                statusText.textContent = '连接断开';
                connectionStatus.textContent = `离线 (重连${status.reconnectAttempts}次)`;
            }
        } else {
            // 演示模式
            setTimeout(() => {
                statusDot.classList.add('connected');
                statusText.textContent = '已连接';
                connectionStatus.textContent = '在线 (演示模式)';
            }, 2000);
        }
    } catch (error) {
        console.error('获取连接状态失败:', error);
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = '状态未知';
        connectionStatus.textContent = '检查中...';
    }
}

// 更新运行时间
function updateUptime() {
    const uptimeElement = document.getElementById('uptime');
    let seconds = 0;

    setInterval(() => {
        seconds++;
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        uptimeElement.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
}

// 更新消息计数
function updateMessageCount() {
    const messageCount = document.getElementById('messageCount');
    
    // 请求真实的消息处理统计
    if (window.electronAPI && window.electronAPI.requestMessageStats) {
        window.electronAPI.requestMessageStats().then(stats => {
            messageCount.textContent = stats.totalMessages || 0;
        }).catch(error => {
            console.error('获取消息统计失败:', error);
            messageCount.textContent = '0';
        });
    } else {
        // 演示模式：显示模拟数据
        let count = 0;
        setInterval(() => {
            count += Math.floor(Math.random() * 3);
            messageCount.textContent = count;
        }, 5000);
    }
}

// 更新管理员数量
function updateAdminCount() {
    const adminCount = document.getElementById('adminCount');
    if (config.adminIds) {
        adminCount.textContent = config.adminIds.length;
    }
}

// 更新群组管理数据
async function updateGroupManagement() {
    try {
        // 请求群组数据
        if (window.electronAPI && window.electronAPI.requestGroupData) {
            const groupData = await window.electronAPI.requestGroupData();
            updateGroupStats(groupData);
        } else {
            // 模拟数据（用于演示模式）
            const mockGroupData = {
                activeGroups: 2,
                totalOperations: 15
            };
            updateGroupStats(mockGroupData);
        }
    } catch (error) {
        console.error('更新群组管理数据失败:', error);
        // 显示错误状态
        updateGroupStats({ activeGroups: 0, totalOperations: 0 });
    }
}

// 更新队列状态
async function updateQueueStatus() {
    const queueStatusElement = document.getElementById('queueStatus');
    
    try {
        if (window.electronAPI && window.electronAPI.requestQueueStatus) {
            const queueStatus = await window.electronAPI.requestQueueStatus();
            queueStatusElement.textContent = queueStatus.queueLength;
            
            // 根据队列长度改变颜色
            if (queueStatus.queueLength > 10) {
                queueStatusElement.style.color = '#ff6b6b';
            } else if (queueStatus.queueLength > 5) {
                queueStatusElement.style.color = '#ffd43b';
            } else {
                queueStatusElement.style.color = '#51cf66';
            }
        } else {
            // 演示模式
            queueStatusElement.textContent = '0';
        }
    } catch (error) {
        console.error('获取队列状态失败:', error);
        queueStatusElement.textContent = '?';
    }
}

// 更新群组统计信息
function updateGroupStats(groupData) {
    const activeGroups = document.getElementById('activeGroups');
    const totalOperations = document.getElementById('totalOperations');
    
    if (activeGroups) {
        activeGroups.textContent = groupData.activeGroups || 0;
    }
    
    if (totalOperations) {
        totalOperations.textContent = groupData.totalOperations || 0;
    }
}



// 开始状态更新
function startStatusUpdates() {
    setInterval(() => {
        if (currentTab === 'dashboard') {
            updateDashboard();
        }
    }, 10000);
}

// 加载日志
function loadLogs() {
    if (window.electronAPI && window.electronAPI.requestLogs) {
        window.electronAPI.requestLogs().then(logData => {
            logs = logData;
            displayLogs(logs);
        }).catch(error => {
            console.error('加载日志失败:', error);
            showNotification('加载日志失败', 'error');
        });
    } else {
        // 模拟日志数据
        const mockLogs = [
            '[10:30:15] [SYSTEM] WhatsApp 机器人 2.0 已启动',
            '[10:30:20] [SYSTEM] 正在连接 WhatsApp...',
            '[10:30:25] [SYSTEM] 连接成功',
            '[10:31:00] [OPERATION] 用户张三执行了查账操作',
            '[10:32:15] [OPERATION] 用户李四执行了清账操作'
        ];
        logs = mockLogs;
        displayLogs(logs);
    }
}

// 显示日志
function displayLogs(logData) {
    const logList = document.getElementById('logList');
    logList.innerHTML = '';

    if (logData.length === 0) {
        logList.innerHTML = '<div class="log-item"><span class="log-message">暂无日志数据</span></div>';
        return;
    }

    logData.forEach(log => {
        const logItem = document.createElement('div');
        logItem.className = 'log-item';
        
        const timeMatch = log.match(/\[([^\]]+)\]/);
        const time = timeMatch ? timeMatch[1] : '';
        const message = log.replace(/\[[^\]]+\]\s*/, '');
        
        logItem.innerHTML = `
            <span class="log-time">[${time}]</span>
            <span class="log-message">${message}</span>
        `;
        
        logList.appendChild(logItem);
    });
}

// 添加日志条目
function addLogEntry(logText) {
    logs.unshift(logText);
    if (logs.length > 100) {
        logs = logs.slice(0, 100);
    }
    
    if (currentTab === 'logs') {
        displayLogs(logs);
    }
}

// 过滤日志
function filterLogs() {
    const levelFilter = document.getElementById('logLevel').value;
    const searchFilter = document.getElementById('logSearch').value.toLowerCase();
    
    let filteredLogs = logs;
    
    if (levelFilter !== 'all') {
        filteredLogs = filteredLogs.filter(log => log.includes(`[${levelFilter}]`));
    }
    
    if (searchFilter) {
        filteredLogs = filteredLogs.filter(log => log.toLowerCase().includes(searchFilter));
    }
    
    displayLogs(filteredLogs);
}

// 加载配置
function loadConfig() {
    if (window.electronAPI && window.electronAPI.requestConfig) {
        window.electronAPI.requestConfig().then(configData => {
            config = configData;
            populateConfigForm(config);
        }).catch(error => {
            console.error('加载配置失败:', error);
            showNotification('加载配置失败', 'error');
        });
    } else {
        // 模拟配置数据
        config = {
            adminIds: ['admin1', 'admin2'],
            maxHistoryRecords: 1000,
            autoBackup: true,
            backupInterval: 24,
            enableNotifications: true
        };
        populateConfigForm(config);
    }
}

// 填充配置表单
function populateConfigForm(configData) {
    document.getElementById('adminIds').value = configData.adminIds ? configData.adminIds.join(', ') : '';
    document.getElementById('maxHistoryRecords').value = configData.maxHistoryRecords || 1000;
    document.getElementById('autoBackup').checked = configData.autoBackup || false;
    document.getElementById('backupInterval').value = configData.backupInterval || 24;
    document.getElementById('enableNotifications').checked = configData.enableNotifications || false;
}

// 保存配置
function saveConfig() {
    const configUpdates = {
        adminIds: document.getElementById('adminIds').value.split(',').map(id => id.trim()).filter(id => id),
        maxHistoryRecords: parseInt(document.getElementById('maxHistoryRecords').value),
        autoBackup: document.getElementById('autoBackup').checked,
        backupInterval: parseInt(document.getElementById('backupInterval').value),
        enableNotifications: document.getElementById('enableNotifications').checked
    };

    if (window.electronAPI && window.electronAPI.updateConfig) {
        window.electronAPI.updateConfig(configUpdates).then(result => {
            if (result.success) {
                showNotification('配置保存成功', 'success');
                config = { ...config, ...configUpdates };
            } else {
                showNotification('配置保存失败: ' + result.error, 'error');
            }
        }).catch(error => {
            console.error('保存配置失败:', error);
            showNotification('保存配置失败', 'error');
        });
    } else {
        // 模拟保存
        config = { ...config, ...configUpdates };
        showNotification('配置保存成功', 'success');
    }
}

// 刷新状态
function refreshStatus() {
    updateDashboard();
    showNotification('状态已刷新', 'info');
}

// 导出数据
function exportData() {
    if (window.electronAPI && window.electronAPI.exportData) {
        // 这里可以添加选择群组的逻辑
        const groupId = 'default';
        window.electronAPI.exportData(groupId).then(result => {
            if (result.success) {
                showNotification('数据导出成功', 'success');
            } else {
                showNotification('数据导出失败: ' + result.error, 'error');
            }
        }).catch(error => {
            console.error('导出数据失败:', error);
            showNotification('导出数据失败', 'error');
        });
    } else {
        showNotification('数据导出功能暂不可用', 'warning');
    }
}

// 清理日志
function clearLogs() {
    if (confirm('确定要清理所有日志吗？此操作不可恢复。')) {
        logs = [];
        displayLogs(logs);
        showNotification('日志已清理', 'success');
    }
}

// 刷新日志
function refreshLogs() {
    loadLogs();
    showNotification('日志已刷新', 'info');
}

// 显示通知
function showNotification(message, type = 'info') {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <div class="notification-content">
            <span class="notification-message">${message}</span>
            <button class="notification-close" onclick="this.parentElement.parentElement.remove()">×</button>
        </div>
    `;

    // 添加样式
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#51cf66' : type === 'error' ? '#ff6b6b' : type === 'warning' ? '#ffd43b' : '#667eea'};
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        z-index: 1000;
        max-width: 300px;
        animation: slideIn 0.3s ease;
    `;

    // 添加动画样式
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        .notification-content {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .notification-close {
            background: none;
            border: none;
            color: white;
            font-size: 18px;
            cursor: pointer;
            margin-left: 10px;
        }
    `;
    document.head.appendChild(style);

    document.body.appendChild(notification);

    // 自动移除通知
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
}

// 键盘快捷键
document.addEventListener('keydown', function(event) {
    // Ctrl/Cmd + R 刷新
    if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
        event.preventDefault();
        if (currentTab === 'dashboard') {
            refreshStatus();
        } else if (currentTab === 'logs') {
            refreshLogs();
        }
    }
    
    // Ctrl/Cmd + S 保存配置
    if ((event.ctrlKey || event.metaKey) && event.key === 's' && currentTab === 'config') {
        event.preventDefault();
        saveConfig();
    }
});

// 错误处理
window.addEventListener('error', function(event) {
    console.error('应用错误:', event.error);
    showNotification('应用发生错误，请检查控制台', 'error');
});

// 未处理的Promise拒绝
window.addEventListener('unhandledrejection', function(event) {
    console.error('未处理的Promise拒绝:', event.reason);
    showNotification('操作失败，请重试', 'error');
});

// 管理员管理功能
function showAddAdminModal() {
    document.getElementById('addAdminModal').style.display = 'block';
    document.getElementById('newAdminName').focus();
}

function closeAddAdminModal() {
    document.getElementById('addAdminModal').style.display = 'none';
    document.getElementById('newAdminName').value = '';
    document.getElementById('newAdminPhone').value = '';
}

function showAdminList() {
    document.getElementById('adminListModal').style.display = 'block';
    loadAdminList();
}

function closeAdminListModal() {
    document.getElementById('adminListModal').style.display = 'none';
}

function loadAdminList() {
    const adminList = document.getElementById('adminList');
    adminList.innerHTML = '<div class="loading">正在加载管理员列表...</div>';

    if (window.electronAPI && window.electronAPI.requestConfig) {
        window.electronAPI.requestConfig().then(configData => {
            const admins = configData.adminIds || [];
            displayAdminList(admins);
        }).catch(error => {
            console.error('加载管理员列表失败:', error);
            adminList.innerHTML = '<div class="empty-list"><i class="fas fa-exclamation-triangle"></i><p>加载失败</p></div>';
        });
    } else {
        // 演示模式
        const mockAdmins = ['演示管理员', 'Tongyang'];
        displayAdminList(mockAdmins);
    }
}

function displayAdminList(admins) {
    const adminList = document.getElementById('adminList');
    
    if (admins.length === 0) {
        adminList.innerHTML = `
            <div class="empty-list">
                <i class="fas fa-users"></i>
                <p>暂无管理员</p>
                <p>点击"添加管理员"来添加第一个管理员</p>
            </div>
        `;
        return;
    }

    const adminItems = admins.map(admin => `
        <div class="admin-item">
            <div class="admin-info">
                <div class="admin-name">${admin}</div>
                <div class="admin-phone">用户名</div>
            </div>
            <div class="admin-actions-item">
                <button class="btn btn-danger btn-sm" onclick="removeAdmin('${admin}')">
                    <i class="fas fa-trash"></i> 删除
                </button>
            </div>
        </div>
    `).join('');

    adminList.innerHTML = adminItems;
}

function addAdmin() {
    const name = document.getElementById('newAdminName').value.trim();
    const phone = document.getElementById('newAdminPhone').value.trim();

    if (!name) {
        showNotification('请输入管理员用户名', 'warning');
        return;
    }

    if (window.electronAPI && window.electronAPI.updateConfig) {
        window.electronAPI.requestConfig().then(configData => {
            const admins = configData.adminIds || [];
            
            if (admins.includes(name)) {
                showNotification('该管理员已存在', 'warning');
                return;
            }

            admins.push(name);
            const newConfig = { ...configData, adminIds: admins };

            window.electronAPI.updateConfig(newConfig).then(result => {
                if (result.success) {
                    showNotification('管理员添加成功', 'success');
                    closeAddAdminModal();
                    updateAdminCount();
                    if (document.getElementById('adminListModal').style.display === 'block') {
                        loadAdminList();
                    }
                } else {
                    showNotification('添加失败: ' + result.error, 'error');
                }
            }).catch(error => {
                console.error('添加管理员失败:', error);
                showNotification('添加失败，请重试', 'error');
            });
        });
    } else {
        // 演示模式
        showNotification('管理员添加成功 (演示模式)', 'success');
        closeAddAdminModal();
        updateAdminCount();
    }
}

function removeAdmin(adminName) {
    if (!confirm(`确定要删除管理员 "${adminName}" 吗？`)) {
        return;
    }

    if (window.electronAPI && window.electronAPI.updateConfig) {
        window.electronAPI.requestConfig().then(configData => {
            const admins = configData.adminIds || [];
            const newAdmins = admins.filter(admin => admin !== adminName);

            if (newAdmins.length === 0) {
                showNotification('不能删除所有管理员，至少保留一个', 'warning');
                return;
            }

            const newConfig = { ...configData, adminIds: newAdmins };

            window.electronAPI.updateConfig(newConfig).then(result => {
                if (result.success) {
                    showNotification('管理员删除成功', 'success');
                    updateAdminCount();
                    loadAdminList();
                } else {
                    showNotification('删除失败: ' + result.error, 'error');
                }
            }).catch(error => {
                console.error('删除管理员失败:', error);
                showNotification('删除失败，请重试', 'error');
            });
        });
    } else {
        // 演示模式
        showNotification('管理员删除成功 (演示模式)', 'success');
        updateAdminCount();
        loadAdminList();
    }
}

// 点击模态框外部关闭
window.onclick = function(event) {
    const addModal = document.getElementById('addAdminModal');
    const listModal = document.getElementById('adminListModal');
    
    if (event.target === addModal) {
        closeAddAdminModal();
    }
    if (event.target === listModal) {
        closeAdminListModal();
    }
}

// 回车键添加管理员
document.addEventListener('keydown', function(event) {
    if (event.key === 'Enter' && document.getElementById('addAdminModal').style.display === 'block') {
        addAdmin();
    }
});
