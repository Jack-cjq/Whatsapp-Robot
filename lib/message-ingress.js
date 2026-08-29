'use strict';

const { classifyCommand, CMD, LatencyRegistry } = require('./runtime-core');

function serializeWid(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value._serialized === 'string') return value._serialized;
    return '';
}

/**
 * whatsapp-web.js 1.34 的 MessageKey 不再总是提供 _serialized。
 * 用稳定字段生成幂等键，避免记账消息失去进程内去重和账本幂等保护。
 */
function serializeMessageId(message) {
    const id = message && message.id;
    if (!id) return null;
    if (typeof id._serialized === 'string' && id._serialized) return id._serialized;

    const token = typeof id.id === 'string' ? id.id : '';
    const remote = serializeWid(id.remote);
    if (!token || !remote) return null;

    const direction = id.fromMe ? 'out' : 'in';
    const participant = serializeWid(id.participant);
    return [direction, remote, participant, token].filter(Boolean).join('|');
}

function createMessageIngressHandler({
    messageStats,
    messageDeduper,
    groupCommandScheduler,
    latencyRegistry,
    logger,
    getRuntimeState
}) {
    return (message) => {
        const receivedAtNs = process.hrtime.bigint();
        try {
            messageStats.totalMessages++;
            if (message.fromMe) return;

            const messageId = serializeMessageId(message);
            const chatId = message.from;
            const senderId = message.author || message.from;
            const body = typeof message.body === 'string' ? message.body : '';
            const notifyName =
                (message._data && (message._data.notifyName || message._data.notify)) || '';

            if (!chatId || typeof chatId !== 'string') {
                messageStats.failedMessages++;
                logger.warn('INVALID_INCOMING_MESSAGE', { reason: 'missing_chat_id' });
                return;
            }
            if (messageDeduper.isDuplicate(messageId)) return;

            const classified = classifyCommand(body);
            if (classified.type === CMD.IGNORE) {
                groupCommandScheduler.droppedNonCommandCount++;
                return;
            }

            const { isConnected, capitalReady, commandEngine } = getRuntimeState();
            logger.info('COMMAND_RECEIVED', {
                chatId,
                messageId,
                commandType: classified.typeName,
                isConnected,
                capitalReady
            });
            if (!capitalReady || !commandEngine) {
                messageStats.failedMessages++;
                logger.warn('COMMAND_ENGINE_NOT_READY', {
                    chatId,
                    isConnected,
                    capitalReady,
                    engineReady: Boolean(commandEngine)
                });
                return;
            }

            const dto = Object.freeze({
                messageId,
                chatId,
                senderId,
                notifyName: typeof notifyName === 'string' ? notifyName : '',
                body,
                type: message.type,
                timestamp: message.timestamp,
                receivedAtNs,
                isGroup: chatId.endsWith('@g.us')
            });

            const enqueuedAtNs = process.hrtime.bigint();
            latencyRegistry.record(
                'receiveToEnqueueMs',
                LatencyRegistry.nsToMs(receivedAtNs, enqueuedAtNs)
            );

            const ok = groupCommandScheduler.enqueue(dto.chatId, {
                enqueuedAtNs,
                run: async () => {
                    const result = await commandEngine.handle(dto, classified);
                    if (!result || typeof result.status !== 'string') {
                        throw new Error('命令引擎返回了无效处理结果');
                    }
                    logger.info('COMMAND_RESULT', {
                        chatId: dto.chatId,
                        messageId: dto.messageId,
                        status: result.status
                    });
                    const localTotalMs = LatencyRegistry.nsToMs(dto.receivedAtNs);
                    latencyRegistry.record('localTotalMs', localTotalMs);
                    latencyRegistry.record('endToEndObservedMs', localTotalMs);
                    return result;
                },
                onError: (error) => {
                    messageStats.failedMessages++;
                    logger.error(error, {
                        context: 'group_command',
                        chatId: dto.chatId,
                        messageId: dto.messageId
                    });
                }
            });
            if (!ok) {
                messageStats.failedMessages++;
                logger.warn('OVERLOAD_REJECT', { chatId });
            }
        } catch (error) {
            messageStats.failedMessages++;
            logger.error(error, { context: 'message_preprocessor' });
        }
    };
}

module.exports = { createMessageIngressHandler, serializeMessageId };
