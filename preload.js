const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 日志相关
    requestLogs: () => ipcRenderer.invoke('request-logs'),
    onLogUpdate: (callback) => ipcRenderer.on('log-update', callback),
    
    // 配置相关
    requestConfig: () => ipcRenderer.invoke('request-config'),
    updateConfig: (configUpdates) => ipcRenderer.invoke('update-config', configUpdates),
    onConfigUpdated: (callback) => ipcRenderer.on('config-updated', callback),
    
    // 群组数据相关
    requestGroupData: () => ipcRenderer.invoke('request-group-data'),
    onGroupDataUpdated: (callback) => ipcRenderer.on('group-data-updated', callback),
    
    // 消息统计相关
    requestMessageStats: () => ipcRenderer.invoke('request-message-stats'),
    onMessageStatsUpdated: (callback) => ipcRenderer.on('message-stats-updated', callback),
    
    // 连接状态相关
    requestConnectionStatus: () => ipcRenderer.invoke('request-connection-status'),
    onConnectionStatusUpdated: (callback) => ipcRenderer.on('connection-status-updated', callback),
    
    // 队列状态相关
    requestQueueStatus: () => ipcRenderer.invoke('request-queue-status'),
    onQueueStatusUpdated: (callback) => ipcRenderer.on('queue-status-updated', callback),
    
    // 数据导出
    exportData: (groupId) => ipcRenderer.invoke('export-data', groupId),
    onExportComplete: (callback) => ipcRenderer.on('export-complete', callback),
    
    // 日志数据
    onLogData: (callback) => ipcRenderer.on('log-data', callback),
    onConfigData: (callback) => ipcRenderer.on('config-data', callback)
});
