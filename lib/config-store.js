'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const DEFAULT_CONFIG = Object.freeze({
    version: '2.0.0',
    adminIds: Object.freeze([]),
    allowedGroupIds: Object.freeze([]),
    maxConcurrentGroups: 8,
    autoBackup: true,
    backupInterval: 24,
    maxHistoryRecords: 1000,
    cleanupDays: 30,
    enableNotifications: true,
    language: 'zh-CN',
    theme: 'default'
});

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const STRING_FIELDS = new Set(['version', 'language', 'theme']);
const BOOLEAN_FIELDS = new Set(['autoBackup', 'enableNotifications']);
const INTEGER_RANGES = {
    maxConcurrentGroups: [1, 128],
    backupInterval: [1, 168],
    maxHistoryRecords: [1, 1000000],
    cleanupDays: [1, 3650]
};
const LIST_FIELDS = new Set(['adminIds', 'allowedGroupIds']);

let writeSequence = 0;

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function normalizeStringList(value, field) {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
    const unique = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'string') throw new Error(`${field} 只能包含字符串`);
        const normalized = item.trim();
        if (!normalized) continue;
        if (normalized.length > 256) throw new Error(`${field} 中的单项过长`);
        if (!seen.has(normalized)) {
            seen.add(normalized);
            unique.push(normalized);
        }
    }
    if (unique.length > 500) throw new Error(`${field} 数量过多`);
    return unique;
}

function validateKnownField(field, value) {
    if (LIST_FIELDS.has(field)) return normalizeStringList(value, field);
    if (BOOLEAN_FIELDS.has(field)) {
        if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`);
        return value;
    }
    if (STRING_FIELDS.has(field)) {
        if (typeof value !== 'string' || !value.trim() || value.length > 64) {
            throw new Error(`${field} 必须是 1-64 个字符`);
        }
        return value;
    }
    if (Object.hasOwn(INTEGER_RANGES, field)) {
        const [min, max] = INTEGER_RANGES[field];
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${field} 必须是 ${min}-${max} 之间的整数`);
        }
        return value;
    }
    return undefined;
}

function validateLoadedConfig(config) {
    if (!isPlainObject(config)) throw new Error('config.json 根节点必须是对象');
    for (const [field, value] of Object.entries(config)) {
        if (DANGEROUS_KEYS.has(field)) throw new Error(`config.json 包含禁止字段: ${field}`);
        if (
            LIST_FIELDS.has(field) ||
            BOOLEAN_FIELDS.has(field) ||
            STRING_FIELDS.has(field) ||
            Object.hasOwn(INTEGER_RANGES, field)
        ) {
            validateKnownField(field, value);
        }
    }
}

function sanitizePatch(current, patch) {
    if (!isPlainObject(patch)) throw new Error('配置更新必须是对象');
    const out = {};
    for (const [field, value] of Object.entries(patch)) {
        if (DANGEROUS_KEYS.has(field)) throw new Error(`禁止修改字段: ${field}`);
        const isKnown =
            LIST_FIELDS.has(field) ||
            BOOLEAN_FIELDS.has(field) ||
            STRING_FIELDS.has(field) ||
            Object.hasOwn(INTEGER_RANGES, field);
        if (isKnown) {
            out[field] = validateKnownField(field, value);
            continue;
        }
        if (Object.hasOwn(current, field) && isDeepStrictEqual(current[field], value)) continue;
        throw new Error(`不支持修改配置字段: ${field}`);
    }
    return out;
}

function writeJsonAtomicSync(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${writeSequence++}`;
    let fd = null;
    try {
        fd = fs.openSync(tmpPath, 'wx');
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch (closeError) {
                error.closeError = closeError.message;
            }
        }
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (cleanupError) {
            error.cleanupError = cleanupError.message;
        }
        throw error;
    }
}

class ConfigFileStore {
    constructor({ getFilePath, defaults = DEFAULT_CONFIG } = {}) {
        if (typeof getFilePath !== 'function') throw new Error('ConfigFileStore 需要 getFilePath');
        this.getFilePath = getFilePath;
        this.defaults = cloneJson(defaults);
        this.cache = null;
    }

    reset() {
        this.cache = null;
    }

    getConfig() {
        if (this.cache) return this.cache;
        const filePath = this.getFilePath();
        if (!fs.existsSync(filePath)) {
            this.cache = cloneJson(this.defaults);
            return this.cache;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        validateLoadedConfig(parsed);
        this.cache = { ...cloneJson(this.defaults), ...parsed };
        return this.cache;
    }

    savePatch(patch) {
        const current = this.getConfig();
        const sanitized = sanitizePatch(current, patch);
        const next = { ...current, ...sanitized };
        validateLoadedConfig(next);
        writeJsonAtomicSync(this.getFilePath(), next);
        this.cache = next;
        return next;
    }
}

module.exports = {
    DEFAULT_CONFIG,
    ConfigFileStore,
    sanitizePatch,
    validateLoadedConfig,
    writeJsonAtomicSync
};
