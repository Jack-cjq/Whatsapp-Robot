'use strict';

async function inspectWhatsappBridge(client) {
    if (!client || !client.pupPage) {
        throw new Error('WhatsApp 浏览器页面尚未创建');
    }
    if (client.pupPage.isClosed()) {
        throw new Error('WhatsApp 浏览器页面已关闭');
    }

    const state = await client.pupPage.evaluate(() => ({
        hasWWebJS: typeof window.WWebJS !== 'undefined',
        hasMessageBridge: typeof window.onAddMessageEvent === 'function',
        socketState: window.require?.('WAWebSocketModel')?.Socket?.state || 'UNKNOWN'
    }));

    if (!state.hasWWebJS || !state.hasMessageBridge) {
        const error = new Error(
            `WhatsApp 消息桥接失效 (WWebJS=${state.hasWWebJS}, messageBridge=${state.hasMessageBridge})`
        );
        error.code = 'WA_MESSAGE_BRIDGE_LOST';
        error.bridgeState = state;
        throw error;
    }
    return state;
}

class WhatsappBridgeWatchdog {
    constructor({ intervalMs = 15000, probe = inspectWhatsappBridge } = {}) {
        if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
            throw new Error('bridge watchdog intervalMs 必须是不小于 1000 的整数');
        }
        if (typeof probe !== 'function') throw new Error('bridge watchdog probe 必须是函数');
        this.intervalMs = intervalMs;
        this.probe = probe;
        this.timer = null;
        this.inFlight = false;
        this.callbacks = null;
    }

    start({ getClient, isConnected, onHealthy, onUnhealthy }) {
        for (const [name, callback] of Object.entries({
            getClient,
            isConnected,
            onHealthy,
            onUnhealthy
        })) {
            if (typeof callback !== 'function') {
                throw new Error(`bridge watchdog ${name} 必须是函数`);
            }
        }

        this.stop();
        this.callbacks = { getClient, isConnected, onHealthy, onUnhealthy };
        this.timer = setInterval(() => this.#scheduleCheck(), this.intervalMs);
        if (this.timer.unref) this.timer.unref();
        this.#scheduleCheck();
    }

    stop() {
        const wasRunning = Boolean(this.timer || this.callbacks);
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.callbacks = null;
        return wasRunning;
    }

    async checkNow() {
        const callbacks = this.callbacks;
        if (!callbacks || this.inFlight || !callbacks.isConnected()) return null;
        const client = callbacks.getClient();
        if (!client) throw new Error('连接状态为在线，但 WhatsApp client 不存在');

        this.inFlight = true;
        try {
            const state = await this.probe(client);
            await callbacks.onHealthy(state);
            return state;
        } catch (error) {
            await callbacks.onUnhealthy(error);
            return null;
        } finally {
            this.inFlight = false;
        }
    }

    #scheduleCheck() {
        this.checkNow().catch((error) => {
            console.error('❌ WhatsApp 桥接健康检查执行失败:', error);
        });
    }
}

module.exports = { inspectWhatsappBridge, WhatsappBridgeWatchdog };
