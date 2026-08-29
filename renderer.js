// 全局变量
let currentTab = 'dashboard';
let logs = [];
let config = {};
let uptimeTimer = null;
let uptimeBaseMs = null;
let uptimeSampledAt = 0;

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
    // 日志批量更新（每批字符串数组）
    if (window.electronAPI && window.electronAPI.onLogUpdateBatch) {
        window.electronAPI.onLogUpdateBatch((event, logLines) => {
            addLogEntries(Array.isArray(logLines) ? logLines : [logLines]);
        });
    }

    // 兼容旧单行事件
    if (window.electronAPI && window.electronAPI.onLogUpdate) {
        window.electronAPI.onLogUpdate((event, logText) => {
            addLogEntries([logText]);
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

    if (window.electronAPI && window.electronAPI.onBootError) {
        window.electronAPI.onBootError((_e, err) => {
            const msg = err && err.message ? err.message : '未知错误';
            const dest = err && err.destinationPath ? `\n新目录: ${err.destinationPath}` : '';
            const src =
                err && err.sourcePaths && err.sourcePaths.length
                    ? `\n旧目录候选: ${err.sourcePaths.join(' | ')}`
                    : '';
            showNotification(`启动失败（机器人未启动）: ${msg}${dest}${src}`, 'error');
        });
    }
    if (window.electronAPI && window.electronAPI.onBrowserMissing) {
        window.electronAPI.onBrowserMissing((_e, info) => {
            showNotification(
                (info && info.message) || '未检测到 Edge/Chrome，请安装浏览器后重试',
                'error'
            );
        });
    }
    if (window.electronAPI && window.electronAPI.onMigrationStatus) {
        window.electronAPI.onMigrationStatus((_e, result) => {
            const migrated = [];
            if (result && result.capitalMigrated) migrated.push('账本');
            if (result && result.configMigrated) migrated.push('配置');
            if (result && result.sessionMigrated) migrated.push('登录会话');
            if (migrated.length > 0) {
                showNotification(`已安全迁移旧${migrated.join('、')}，原数据仍保留`, 'success');
            }
            const hasSessionConflict = Array.isArray(result && result.conflicts) &&
                result.conflicts.some((item) => item && item.type === 'session');
            if (hasSessionConflict) {
                showNotification('检测到两套 WhatsApp 登录会话，已保留 EXE 当前会话，未自动合并', 'warning');
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
            if (Number.isFinite(status.uptime) && status.uptime >= 0) {
                uptimeBaseMs = status.uptime;
                uptimeSampledAt = Date.now();
                renderUptime();
            }
            
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
    if (uptimeTimer) return;
    renderUptime();
    uptimeTimer = setInterval(renderUptime, 1000);
}

function renderUptime() {
    const uptimeElement = document.getElementById('uptime');
    if (!uptimeElement || uptimeBaseMs === null) return;
    const elapsedMs = uptimeBaseMs + Math.max(0, Date.now() - uptimeSampledAt);
    const seconds = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    uptimeElement.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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

function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(text);
    return element;
}

function renderMessageState(container, className, iconClass, messages) {
    const wrapper = document.createElement('div');
    wrapper.className = className;
    if (iconClass) {
        const icon = document.createElement('i');
        icon.className = iconClass;
        wrapper.appendChild(icon);
    }
    for (const message of messages) wrapper.appendChild(createTextElement('p', '', message));
    container.replaceChildren(wrapper);
}

// 显示日志
function displayLogs(logData) {
    const logList = document.getElementById('logList');
    logList.replaceChildren();

    if (logData.length === 0) {
        const emptyItem = document.createElement('div');
        emptyItem.className = 'log-item';
        emptyItem.appendChild(createTextElement('span', 'log-message', '暂无日志数据'));
        logList.appendChild(emptyItem);
        return;
    }

    logData.forEach(log => {
        const logItem = document.createElement('div');
        logItem.className = 'log-item';
        
        const timeMatch = log.match(/\[([^\]]+)\]/);
        const time = timeMatch ? timeMatch[1] : '';
        const message = log.replace(/\[[^\]]+\]\s*/, '');
        
        logItem.appendChild(createTextElement('span', 'log-time', `[${time}]`));
        logItem.appendChild(createTextElement('span', 'log-message', message));
        logList.appendChild(logItem);
    });
}

// 添加日志条目（最多保留 500 行）
function addLogEntry(logText) {
    addLogEntries([logText]);
}

function addLogEntries(logLines) {
    if (!logLines || !logLines.length) return;
    for (let i = logLines.length - 1; i >= 0; i--) {
        logs.unshift(logLines[i]);
    }
    if (logs.length > 500) {
        logs = logs.slice(0, 500);
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
    document.getElementById('maxHistoryRecords').value = configData.maxHistoryRecords ?? 1000;
    document.getElementById('autoBackup').checked = configData.autoBackup === true;
    document.getElementById('backupInterval').value = configData.backupInterval ?? 24;
    document.getElementById('enableNotifications').checked = configData.enableNotifications === true;
}

// 保存配置
function saveConfig() {
    const maxHistoryRecords = Number.parseInt(document.getElementById('maxHistoryRecords').value, 10);
    const backupInterval = Number.parseInt(document.getElementById('backupInterval').value, 10);
    if (!Number.isInteger(maxHistoryRecords) || maxHistoryRecords < 100 || maxHistoryRecords > 10000) {
        showNotification('最大历史记录数必须在 100-10000 之间', 'warning');
        return;
    }
    if (!Number.isInteger(backupInterval) || backupInterval < 1 || backupInterval > 168) {
        showNotification('备份间隔必须在 1-168 小时之间', 'warning');
        return;
    }
    const configUpdates = {
        adminIds: document.getElementById('adminIds').value.split(',').map(id => id.trim()).filter(id => id),
        maxHistoryRecords,
        autoBackup: document.getElementById('autoBackup').checked,
        backupInterval,
        enableNotifications: document.getElementById('enableNotifications').checked
    };

    if (window.electronAPI && window.electronAPI.updateConfig) {
        window.electronAPI.updateConfig(configUpdates).then(result => {
            if (result.success) {
                showNotification('配置保存成功', 'success');
                config = result.config || { ...config, ...configUpdates };
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
    const allowedTypes = new Set(['info', 'success', 'warning', 'error']);
    const safeType = allowedTypes.has(type) ? type : 'info';
    const notification = document.createElement('div');
    notification.className = `notification notification-${safeType}`;
    const content = document.createElement('div');
    content.className = 'notification-content';
    content.appendChild(createTextElement('span', 'notification-message', message));
    const closeButton = createTextElement('button', 'notification-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭通知');
    closeButton.addEventListener('click', () => notification.remove());
    content.appendChild(closeButton);
    notification.appendChild(content);

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
    renderMessageState(adminList, 'loading', '', ['正在加载管理员列表...']);

    if (window.electronAPI && window.electronAPI.requestConfig) {
        window.electronAPI.requestConfig().then(configData => {
            const admins = configData.adminIds || [];
            displayAdminList(admins);
        }).catch(error => {
            console.error('加载管理员列表失败:', error);
            renderMessageState(
                adminList,
                'empty-list',
                'fas fa-exclamation-triangle',
                ['加载失败']
            );
        });
    } else {
        // 演示模式
        const mockAdmins = ['演示管理员', '示例管理员'];
        displayAdminList(mockAdmins);
    }
}

function displayAdminList(admins) {
    const adminList = document.getElementById('adminList');
    
    if (admins.length === 0) {
        renderMessageState(
            adminList,
            'empty-list',
            'fas fa-users',
            ['暂无管理员', '点击"添加管理员"来添加第一个管理员']
        );
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const admin of admins) {
        const item = document.createElement('div');
        item.className = 'admin-item';
        const info = document.createElement('div');
        info.className = 'admin-info';
        info.appendChild(createTextElement('div', 'admin-name', admin));
        info.appendChild(createTextElement('div', 'admin-phone', '用户名'));
        const actions = document.createElement('div');
        actions.className = 'admin-actions-item';
        const removeButton = createTextElement('button', 'btn btn-danger btn-sm', '删除');
        removeButton.type = 'button';
        removeButton.addEventListener('click', () => removeAdmin(admin));
        actions.appendChild(removeButton);
        item.append(info, actions);
        fragment.appendChild(item);
    }
    adminList.replaceChildren(fragment);
}

function addAdmin() {
    const name = document.getElementById('newAdminName').value.trim();

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

            const newConfig = { adminIds: [...admins, name] };

            window.electronAPI.updateConfig(newConfig).then(result => {
                if (result.success) {
                    config = result.config || { ...configData, ...newConfig };
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

            const newConfig = { adminIds: newAdmins };

            window.electronAPI.updateConfig(newConfig).then(result => {
                if (result.success) {
                    config = result.config || { ...configData, ...newConfig };
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
