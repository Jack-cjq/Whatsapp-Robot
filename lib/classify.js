'use strict';

/**
 * 超快速命令分类器：纯函数、预编译正则、单次 trim、尽早退出
 */

const RE_SIMPLE_CALC = /^([+\-*/×÷])\s*(\d+(?:\.\d+)?)(?:\s*#.*)?$/;
const RE_HAS_MATH_OP = /[+\-*/×÷()]/;
const RE_MATH_BODY = /^[\d+\-*/×÷().,]+(?:\s*#.*)?$/;
const RE_COMPLEX = /[+\-*/×÷].*[+\-*/×÷]/;
const RE_STARTS_OP = /^[+\-*/×÷]/;

const CMD = Object.freeze({
    CALCULATE: 1,
    QUERY: 2,
    UNDO: 3,
    CLEAR: 4,
    HELP: 5,
    IGNORE: 0
});

const CMD_NAME = Object.freeze({
    0: 'IGNORE',
    1: 'CALCULATE',
    2: 'QUERY',
    3: 'UNDO',
    4: 'CLEAR',
    5: 'HELP'
});

const EXACT = new Map([
    ['查账', CMD.QUERY],
    ['/查账', CMD.QUERY],
    ['撤回', CMD.UNDO],
    ['/撤回', CMD.UNDO],
    ['清账', CMD.CLEAR],
    ['/清账', CMD.CLEAR],
    ['帮助', CMD.HELP],
    ['/帮助', CMD.HELP]
]);

/**
 * @param {string} body
 * @returns {{ type: number, typeName: string, trimmed: string, operator?: string, value?: number, expression?: string, comment?: string }}
 */
function classifyCommand(body) {
    if (body == null || typeof body !== 'string') {
        return { type: CMD.IGNORE, typeName: 'IGNORE', trimmed: '' };
    }

    // 尽早退出：空或明显非命令首字符
    if (body.length === 0) {
        return { type: CMD.IGNORE, typeName: 'IGNORE', trimmed: '' };
    }

    const trimmed = body.trim();
    if (trimmed.length === 0) {
        return { type: CMD.IGNORE, typeName: 'IGNORE', trimmed: '' };
    }

    const exact = EXACT.get(trimmed);
    if (exact !== undefined) {
        return { type: exact, typeName: CMD_NAME[exact], trimmed };
    }

    // 简单 ±*/ 数字
    const m = RE_SIMPLE_CALC.exec(trimmed);
    if (m) {
        return {
            type: CMD.CALCULATE,
            typeName: 'CALCULATE',
            trimmed,
            operator: m[1] === '×' ? '*' : m[1] === '÷' ? '/' : m[1],
            value: parseFloat(m[2]),
            expression: trimmed,
            comment: ''
        };
    }

    // 复合表达式：必须以运算符开头
    const noSpace = trimmed.replace(/\s+/g, '');
    if (!RE_STARTS_OP.test(noSpace)) {
        return { type: CMD.IGNORE, typeName: 'IGNORE', trimmed };
    }
    if (!RE_HAS_MATH_OP.test(noSpace)) {
        return { type: CMD.IGNORE, typeName: 'IGNORE', trimmed };
    }

    const hashIdx = trimmed.indexOf('#');
    const calcPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx).trim() : trimmed;
    const comment = hashIdx >= 0 ? trimmed.slice(hashIdx + 1).trim() : '';
    const calcNoSpace = calcPart.replace(/\s+/g, '');

    if (RE_MATH_BODY.test(calcNoSpace) || RE_COMPLEX.test(calcNoSpace)) {
        return {
            type: CMD.CALCULATE,
            typeName: 'CALCULATE',
            trimmed,
            expression: calcPart,
            comment,
            complex: true
        };
    }

    return { type: CMD.IGNORE, typeName: 'IGNORE', trimmed };
}

function isSupportedBotCommand(body) {
    return classifyCommand(body).type !== CMD.IGNORE;
}

function isMathExpression(text) {
    const c = classifyCommand(text);
    return c.type === CMD.CALCULATE && !!c.complex;
}

module.exports = {
    CMD,
    CMD_NAME,
    classifyCommand,
    isSupportedBotCommand,
    isMathExpression
};
