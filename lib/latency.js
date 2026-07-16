'use strict';

/**
 * 延迟直方图：用 hrtime 采样，输出 P50/P95/P99/max（毫秒）
 */
class LatencyHistogram {
    constructor(name, capacity = 20000) {
        this.name = name;
        this.capacity = capacity;
        this.samples = new Float64Array(capacity);
        this.count = 0;
        this.writeIndex = 0;
        this.max = 0;
    }

    record(ms) {
        const v = Number(ms);
        if (!Number.isFinite(v) || v < 0) return;
        this.samples[this.writeIndex] = v;
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
        if (v > this.max) this.max = v;
    }

    reset() {
        this.count = 0;
        this.writeIndex = 0;
        this.max = 0;
    }

    percentile(p) {
        if (this.count === 0) return 0;
        const arr = Array.from(this.samples.subarray(0, this.count));
        arr.sort((a, b) => a - b);
        const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
        return arr[idx];
    }

    snapshot() {
        return {
            name: this.name,
            count: this.count,
            p50: this.percentile(50),
            p95: this.percentile(95),
            p99: this.percentile(99),
            max: this.max
        };
    }
}

class LatencyRegistry {
    constructor() {
        this.map = new Map();
    }

    hist(name) {
        if (!this.map.has(name)) this.map.set(name, new LatencyHistogram(name));
        return this.map.get(name);
    }

    record(name, ms) {
        this.hist(name).record(ms);
    }

    /** @returns {number} ms */
    static nsToMs(startNs, endNs = process.hrtime.bigint()) {
        return Number(endNs - startNs) / 1e6;
    }

    nowNs() {
        return process.hrtime.bigint();
    }

    snapshotAll() {
        const out = {};
        for (const [k, h] of this.map) out[k] = h.snapshot();
        return out;
    }

    resetAll() {
        for (const h of this.map.values()) h.reset();
    }
}

module.exports = { LatencyHistogram, LatencyRegistry };
