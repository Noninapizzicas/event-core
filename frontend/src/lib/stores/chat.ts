/**
 * Chat Store - Estado de conversación
 *
 * Gestiona:
 * - Mensajes de la conversación
 * - ID de conversación activa
 * - Estado de streaming
 * - Envío de mensajes
 * - Toggle de contexto por mensaje
 */

import { writable, derived, get } from 'svelte/store';
import { publish, subscribe, mqttRequest } from '$lib/ui-core';
import type { Message, Attachment } from '$lib/ui-core';
import { attachments, clearAttachments } from './attachments';
import { activeProjectId } from './projects';
import { notifyError } from './ui';
import { generateUUID } from '$lib/utils';
import { getPageContextSnapshot } from './page-context';

// ============================================================================
// STORES
// ============================================================================

export const messages = writable<Message[]>([]);
export const conversationId = writable<string | null>(null);
export const isStreaming = writable<boolean>(false);
export const streamingMessageId = writable<string | null>(null);
export const toolStatus = writable<{ name: string; status: string } | null>(null);

// ============================================================================
// STORES DERIVADOS
// ============================================================================

/**
 * Número de mensajes
 */
export const messageCount = derived(messages, ($messages) => $messages.length);

/**
 * ¿Hay conversación activa?
 */
export const hasConversation = derived(conversationId, ($id) => $id !== null);

/**
 * Último mensaje
 */
export const lastMessage = derived(messages, ($messages) => {
  return $messages.length > 0 ? $messages[$messages.length - 1] : null;
});

/**
 * Mensajes del usuario
 */
export const userMessages = derived(messages, ($messages) => {
  return $messages.filter(m => m.role === 'user');
});

/**
 * Mensajes del asistente
 */
export const assistantMessages = derived(messages, ($messages) => {
  return $messages.filter(m => m.role === 'assistant');
});

// ============================================================================
// ACCIONES
// ============================================================================

/**
 * Enviar mensaje
 */
export async function sendMessage(content: string): Promise<void> {
  const convId = get(conversationId);
  const currentAttachments = get(attachments);

  if (!content.trim() && currentAttachments.length === 0) {
    return;
  }

  // Crear mensaje del usuario
  const userMessage: Message = {
    id: generateUUID(),
    role: 'user',
    content: content.trim(),
    timestamp: new Date().toISOString(),
    attachments: currentAttachments.length > 0 ? [...currentAttachments] : undefined
  };

  // Añadir mensaje inmediatamente
  messages.update(msgs => [...msgs, userMessage]);

  // Limpiar adjuntos
  clearAttachments();

  // Marcar como streaming
  isStreaming.set(true);

  // Enviar via mqttRequest (patrón ui/request/conversation/send)
  try {
    // Capturar contexto de página (si hay) para inyectar en el system prompt
    const currentPageContext = getPageContextSnapshot();
    console.log('[Chat] sendMessage pageContext:', currentPageContext ? { route: currentPageContext.route, title: currentPageContext.title, stateKeys: Object.keys(currentPageContext.state || {}) } : null);

    const response = await mqttRequest<{
      conversationId: string;
      user_message: Message;
      assistant_message: Message;
      tokens_used?: number;
      cost?: number;
    }>('conversation', 'send', {
      conversationId: convId,
      content: userMessage.content,
      attachments: currentAttachments.map(a => ({
        type: a.type,
        path: a.path,
        name: a.name
      })),
      pageContext: currentPageContext || undefined
    }, { timeout: 180000 }); // 180s para respuestas de IA con herramientas

    // Añadir mensaje del asistente si existe (está en response.data)
    const data = response?.data;
    if (data?.assistant_message) {
      messages.update(msgs => {
        // Check if streaming already added this message (by content match or streaming flag)
        const lastIdx = msgs.length - 1;
        const lastMsg = msgs[lastIdx];

        if (lastMsg?.role === 'assistant') {
          // Finalize: update with server-confirmed data (id, full content, metadata)
          return [
            ...msgs.slice(0, lastIdx),
            {
              ...lastMsg,
              id: data.assistant_message.id || lastMsg.id,
              content: data.assistant_message.content || lastMsg.content,
              timestamp: data.assistant_message.created_at || lastMsg.timestamp,
              metadata: data.assistant_message.metadata,
              in_context: data.assistant_message.in_context !== false,
              streaming: false
            }
          ];
        }

        // No streaming happened: add the message normally
        return [...msgs, {
          id: data.assistant_message.id || generateUUID(),
          role: 'assistant',
          content: data.assistant_message.content,
          timestamp: data.assistant_message.created_at || new Date().toISOString(),
          metadata: data.assistant_message.metadata,
          in_context: data.assistant_message.in_context !== false
        }];
      });
    }

    // Actualizar conversationId si se creó una nueva
    if (data?.conversationId && data.conversationId !== convId) {
      conversationId.set(data.conversationId);
    }

    isStreaming.set(false);
    streamingMessageId.set(null);
  } catch (error: any) {
    console.error('[chat] Error sending message:', error);
    isStreaming.set(false);
    streamingMessageId.set(null);

    // Mostrar error al usuario
    const errorMsg = error?.response?.error?.message
      || error?.message
      || 'Error al enviar mensaje';
    notifyError(errorMsg);
  }
}

/**
 * Añadir mensaje (usado por suscripciones MQTT)
 */
export function addMessage(message: Message): void {
  messages.update(msgs => {
    const lastIdx = msgs.length - 1;
    const lastMsg = msgs[lastIdx];

    if (message.role === 'assistant' && lastMsg?.role === 'assistant') {
      if (message.streaming) {
        // Chunk de streaming: actualizar contenido del mensaje existente
        return [
          ...msgs.slice(0, lastIdx),
          { ...lastMsg, content: message.content, streaming: true }
        ];
      } else {
        // Mensaje final (sin streaming): finalizar el mensaje existente con datos completos
        return [
          ...msgs.slice(0, lastIdx),
          {
            ...lastMsg,
            id: message.id || lastMsg.id,
            content: message.content || lastMsg.content,
            timestamp: message.timestamp || lastMsg.timestamp,
            streaming: false
          }
        ];
      }
    }

    return [...msgs, message];
  });

  if (message.streaming) {
    streamingMessageId.set(message.id);
  } else if (message.role === 'assistant') {
    // Mensaje final recibido - limpiar streaming
    streamingMessageId.set(null);
  }
}

/**
 * Finalizar streaming
 */
export function endStreaming(): void {
  isStreaming.set(false);
  toolStatus.set(null);

  // Marcar último mensaje como no-streaming
  messages.update(msgs => {
    if (msgs.length === 0) return msgs;

    const lastIdx = msgs.length - 1;
    const lastMsg = msgs[lastIdx];

    if (lastMsg.streaming) {
      return [
        ...msgs.slice(0, lastIdx),
        { ...lastMsg, streaming: false }
      ];
    }

    return msgs;
  });

  streamingMessageId.set(null);
}

/**
 * Stop generation - detiene la recepcion de streaming
 * Mantiene el contenido parcial que ya se recibio
 */
export function stopGeneration(): void {
  endStreaming();
}

/**
 * Cargar conversación - usa conversation.get para obtener TODOS los mensajes
 */
export async function loadConversation(id: string): Promise<void> {
  conversationId.set(id);
  messages.set([]);

  try {
    const response = await mqttRequest<{
      conversation: any;
      messages: any[];
    }>('conversation', 'get', {
      conversationId: id
    });
    if (response?.data?.messages) {
      // Map backend fields (created_at) to frontend fields (timestamp)
      const mapped = response.data.messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.created_at || m.timestamp || new Date().toISOString(),
        attachments: m.attachments,
        metadata: m.metadata,
        in_context: m.in_context !== false && m.in_context !== 0,
        manually_toggled: m.manually_toggled === true || m.manually_toggled === 1
      }));
      messages.set(mapped);
    }
  } catch (error) {
    console.error('[chat] Error loading conversation:', error);
  }
}

/**
 * Nueva conversación
 */
export function newConversation(): void {
  const newId = generateUUID();
  conversationId.set(newId);
  messages.set([]);
}

/**
 * Limpiar mensajes
 */
export function clearMessages(): void {
  messages.set([]);
}

/**
 * Limpiar todo (conversación + mensajes)
 */
export function clearConversation(): void {
  conversationId.set(null);
  messages.set([]);
  isStreaming.set(false);
  streamingMessageId.set(null);
}

/**
 * Toggle de contexto de un mensaje
 * Actualiza el store local y envía al backend
 */
export async function toggleMessageContext(messageId: string, inContext: boolean): Promise<void> {
  const projId = get(activeProjectId);

  // Optimistic update en el store de mensajes visibles
  messages.update(msgs =>
    msgs.map(m =>
      m.id === messageId
        ? { ...m, in_context: inContext, manually_toggled: true }
        : m
    )
  );

  try {
    await mqttRequest('conversation', 'toggleContext', {
      projectId: projId,
      messageId,
      inContext
    });
  } catch (error) {
    // Rollback on error
    messages.update(msgs =>
      msgs.map(m =>
        m.id === messageId
          ? { ...m, in_context: !inContext, manually_toggled: true }
          : m
      )
    );
    console.error('[chat] Toggle context failed:', error);
    throw error;
  }
}

// ============================================================================
// SUSCRIPCIONES MQTT
// ============================================================================

/**
 * Inicializar suscripciones MQTT
 * Llamar al montar la app
 */
export function initChatSubscriptions(): () => void {
  const unsubs: Array<() => void> = [];

  /**
   * Extraer conversation_id del topic MQTT.
   * Topic: conversation/{conv_id}/message → conv_id
   */
  function getConvIdFromTopic(topic: string): string | null {
    const parts = topic.split('/');
    return parts.length >= 2 ? parts[1] : null;
  }

  /**
   * Verificar si un mensaje pertenece a la conversación activa.
   * Si no hay conversación activa, aceptar todos (para nuevas conversaciones).
   */
  function isActiveConversation(topic: string): boolean {
    const convId = get(conversationId);
    if (!convId) return true; // Sin conversación activa = aceptar todo
    const topicConvId = getConvIdFromTopic(topic);
    if (!topicConvId || topicConvId === '+') return true; // Topic sin conv_id
    return topicConvId === convId;
  }

  // Mensaje recibido — filtrar por conversación activa
  unsubs.push(subscribe('conversation/+/message', (topic, payload) => {
    if (!isActiveConversation(topic)) return; // Ignorar mensajes de otras conversaciones

    const data = payload as Message;
    addMessage({
      id: data.id || generateUUID(),
      role: data.role,
      content: data.content,
      timestamp: data.timestamp || new Date().toISOString(),
      streaming: data.streaming,
      attachments: data.attachments
    });
  }));

  // Tool status — filtrar por conversación activa
  unsubs.push(subscribe('conversation/+/tool-status', (topic, payload) => {
    if (!isActiveConversation(topic)) return;

    const data = payload as { tool: { name: string; status: string } };
    if (data.tool) {
      toolStatus.set(data.tool);
    }
  }));

  // Fin de streaming (solo finaliza el mensaje, NO desbloquea envío)
  unsubs.push(subscribe('conversation/stream/end', () => {
    toolStatus.set(null);

    // Solo finalizar el último mensaje de streaming (quitar flag streaming)
    // NO tocar isStreaming - eso lo controla sendMessage/stopGeneration
    messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const lastIdx = msgs.length - 1;
      const lastMsg = msgs[lastIdx];
      if (lastMsg.streaming) {
        return [
          ...msgs.slice(0, lastIdx),
          { ...lastMsg, streaming: false }
        ];
      }
      return msgs;
    });
    streamingMessageId.set(null);
  }));

  // Conversación cargada
  unsubs.push(subscribe('conversation/loaded', (_, payload) => {
    const data = payload as { messages: Message[] };
    messages.set(data.messages || []);
  }));

  // Retornar cleanup
  return () => {
    unsubs.forEach(fn => fn());
  };
}

// ============================================================================
// GETTERS
// ============================================================================

export function getMessages(): Message[] {
  return get(messages);
}

export function getConversationId(): string | null {
  return get(conversationId);
}

export function getIsStreaming(): boolean {
  return get(isStreaming);
}
