/**
 * Agent Communication Protocol Service.
 *
 * A proper messaging layer for agent-to-agent communication with:
 * - Typed message channels (signal, trade-proposal, market-update, alert, chat)
 * - Message encryption (AES-256-GCM between agents)
 * - Broadcast channels (one-to-many communication)
 * - Message threading (conversations with context)
 * - Message acknowledgment & delivery tracking
 * - Channel subscription management
 */

import { v4 as uuid } from 'uuid';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { StateStore } from '../infra/storage/stateStore.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

// ─── Types ────────────────────────────────────────────────────────────

export type CommMessageType = 'signal' | 'trade-proposal' | 'market-update' | 'alert' | 'chat';

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface CommMessage {
  id: string;
  channelId: string | null;
  from: string;
  to: string | null;             // null for broadcast/channel messages
  type: CommMessageType;
  subject: string;
  body: string;
  encrypted: boolean;
  encryptedBody: string | null;  // hex-encoded ciphertext when encrypted
  iv: string | null;             // hex-encoded IV when encrypted
  authTag: string | null;        // hex-encoded auth tag when encrypted
  threadId: string | null;
  parentMessageId: string | null;
  deliveryStatus: DeliveryStatus;
  acknowledgedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CommChannel {
  id: string;
  name: string;
  description: string;
  type: 'broadcast' | 'group' | 'direct';
  creatorId: string;
  subscriberIds: string[];
  allowedMessageTypes: CommMessageType[];
  createdAt: string;
  updatedAt: string;
}

export interface SendMessageInput {
  from: string;
  to?: string;
  channelId?: string;
  type: CommMessageType;
  subject: string;
  body: string;
  encrypt?: boolean;
  threadId?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateChannelInput {
  name: string;
  description?: string;
  type: 'broadcast' | 'group' | 'direct';
  creatorId: string;
  allowedMessageTypes?: CommMessageType[];
}

// ─── Constants ────────────────────────────────────────────────────────

const MAX_MESSAGES = 50_000;
const MAX_CHANNELS = 5_000;
const VALID_TYPES: CommMessageType[] = ['signal', 'trade-proposal', 'market-update', 'alert', 'chat'];
const ENCRYPTION_ALGO = 'aes-256-gcm';

// ─── Service ──────────────────────────────────────────────────────────

export class AgentCommService {
  private messages: CommMessage[] = [];
  private channels: Map<string, CommChannel> = new Map();
  private serverSecret: string;

  constructor(
    private readonly store: StateStore,
    serverSecret?: string,
  ) {
    this.serverSecret = serverSecret ?? 'agent-comm-default-secret';
  }

  // ── Encryption helpers ─────────────────────────────────────────────

  private deriveKey(fromId: string, toId: string): Buffer {
    const material = [fromId, toId].sort().join(':') + ':' + this.serverSecret;
    return createHash('sha256').update(material).digest();
  }

  private encryptPayload(plaintext: string, fromId: string, toId: string): { ciphertext: string; iv: string; authTag: string } {
    const key = this.deriveKey(fromId, toId);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  decryptPayload(ciphertext: string, iv: string, authTag: string, fromId: string, toId: string): string {
    const key = this.deriveKey(fromId, toId);
    const decipher = createDecipheriv(ENCRYPTION_ALGO, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  // ── Send a message ─────────────────────────────────────────────────

  sendMessage(input: SendMessageInput): CommMessage {
    const state = this.store.snapshot();

    // Validate sender
    if (!state.agents[input.from]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Sender agent not found.');
    }

    // Validate type
    if (!VALID_TYPES.includes(input.type)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Invalid message type. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    // Must have either `to` or `channelId`
    if (!input.to && !input.channelId) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Either "to" (recipient agentId) or "channelId" is required.');
    }

    // Validate recipient if direct message
    if (input.to && !state.agents[input.to]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Recipient agent not found.');
    }

    // Validate channel if provided
    if (input.channelId) {
      const channel = this.channels.get(input.channelId);
      if (!channel) {
        throw new DomainError(ErrorCode.InvalidPayload, 404, 'Channel not found.');
      }
      if (!channel.subscriberIds.includes(input.from)) {
        throw new DomainError(ErrorCode.InvalidPayload, 403, 'Sender is not subscribed to this channel.');
      }
      if (channel.allowedMessageTypes.length > 0 && !channel.allowedMessageTypes.includes(input.type)) {
        throw new DomainError(ErrorCode.InvalidPayload, 400, `Message type "${input.type}" is not allowed in this channel.`);
      }
    }

    // Validate thread reference
    if (input.parentMessageId) {
      const parent = this.messages.find((m) => m.id === input.parentMessageId);
      if (!parent) {
        throw new DomainError(ErrorCode.InvalidPayload, 400, 'Parent message not found.');
      }
    }

    // Determine threadId
    let threadId = input.threadId ?? null;
    if (!threadId && input.parentMessageId) {
      const parent = this.messages.find((m) => m.id === input.parentMessageId);
      threadId = parent?.threadId ?? input.parentMessageId;
    }

    // Encryption
    let encryptedBody: string | null = null;
    let iv: string | null = null;
    let authTag: string | null = null;
    const shouldEncrypt = input.encrypt === true && input.to;

    if (shouldEncrypt && input.to) {
      const enc = this.encryptPayload(input.body, input.from, input.to);
      encryptedBody = enc.ciphertext;
      iv = enc.iv;
      authTag = enc.authTag;
    }

    const message: CommMessage = {
      id: uuid(),
      channelId: input.channelId ?? null,
      from: input.from,
      to: input.to ?? null,
      type: input.type,
      subject: input.subject,
      body: shouldEncrypt ? '[encrypted]' : input.body,
      encrypted: !!shouldEncrypt,
      encryptedBody,
      iv,
      authTag,
      threadId,
      parentMessageId: input.parentMessageId ?? null,
      deliveryStatus: 'sent',
      acknowledgedAt: null,
      metadata: input.metadata ?? {},
      createdAt: isoNow(),
    };

    this.messages.push(message);
    this.trimMessages();

    eventBus.emit('comm.message.sent', {
      messageId: message.id,
      from: message.from,
      to: message.to,
      channelId: message.channelId,
      type: message.type,
      encrypted: message.encrypted,
      threadId: message.threadId,
    });

    return structuredClone(message);
  }

  // ── Get inbox ──────────────────────────────────────────────────────

  getInbox(agentId: string, limit = 50): CommMessage[] {
    return this.messages
      .filter((m) => m.to === agentId || this.isChannelRecipient(m, agentId))
      .slice(-limit)
      .reverse()
      .map((m) => structuredClone(m));
  }

  private isChannelRecipient(message: CommMessage, agentId: string): boolean {
    if (!message.channelId) return false;
    const channel = this.channels.get(message.channelId);
    if (!channel) return false;
    return channel.subscriberIds.includes(agentId) && message.from !== agentId;
  }

  // ── Acknowledge a message ──────────────────────────────────────────

  acknowledgeMessage(messageId: string, agentId: string): CommMessage {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Message not found.');
    }
    if (message.to !== agentId && !this.isChannelRecipient(message, agentId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 403, 'Agent is not the recipient of this message.');
    }

    message.deliveryStatus = 'read';
    message.acknowledgedAt = isoNow();

    eventBus.emit('comm.message.acknowledged', {
      messageId: message.id,
      agentId,
    });

    return structuredClone(message);
  }

  // ── Get thread ────────────────────────────────────────────────────

  getThread(threadId: string, limit = 50): CommMessage[] {
    return this.messages
      .filter((m) => m.threadId === threadId || m.id === threadId)
      .slice(-limit)
      .map((m) => structuredClone(m));
  }

  // ── Channel management ────────────────────────────────────────────

  createChannel(input: CreateChannelInput): CommChannel {
    const state = this.store.snapshot();

    if (!state.agents[input.creatorId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Creator agent not found.');
    }

    // Check duplicate channel name
    for (const ch of this.channels.values()) {
      if (ch.name === input.name) {
        throw new DomainError(ErrorCode.InvalidPayload, 409, `Channel with name "${input.name}" already exists.`);
      }
    }

    const channel: CommChannel = {
      id: uuid(),
      name: input.name,
      description: input.description ?? '',
      type: input.type,
      creatorId: input.creatorId,
      subscriberIds: [input.creatorId],
      allowedMessageTypes: input.allowedMessageTypes ?? [],
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };

    this.channels.set(channel.id, channel);

    eventBus.emit('comm.channel.created', {
      channelId: channel.id,
      name: channel.name,
      type: channel.type,
      creatorId: channel.creatorId,
    });

    return structuredClone(channel);
  }

  listChannels(): CommChannel[] {
    return Array.from(this.channels.values()).map((ch) => structuredClone(ch));
  }

  getChannel(channelId: string): CommChannel | null {
    const channel = this.channels.get(channelId);
    return channel ? structuredClone(channel) : null;
  }

  // ── Channel subscription ──────────────────────────────────────────

  subscribeToChannel(channelId: string, agentId: string): CommChannel {
    const state = this.store.snapshot();

    if (!state.agents[agentId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
    }

    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Channel not found.');
    }

    if (channel.subscriberIds.includes(agentId)) {
      throw new DomainError(ErrorCode.InvalidPayload, 409, 'Agent is already subscribed to this channel.');
    }

    channel.subscriberIds.push(agentId);
    channel.updatedAt = isoNow();

    eventBus.emit('comm.channel.subscribed', {
      channelId: channel.id,
      agentId,
    });

    return structuredClone(channel);
  }

  unsubscribeFromChannel(channelId: string, agentId: string): CommChannel {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Channel not found.');
    }

    const idx = channel.subscriberIds.indexOf(agentId);
    if (idx === -1) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Agent is not subscribed to this channel.');
    }

    channel.subscriberIds.splice(idx, 1);
    channel.updatedAt = isoNow();

    eventBus.emit('comm.channel.unsubscribed', {
      channelId: channel.id,
      agentId,
    });

    return structuredClone(channel);
  }

  // ── Channel messages ──────────────────────────────────────────────

  getChannelMessages(channelId: string, limit = 50): CommMessage[] {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, 'Channel not found.');
    }

    return this.messages
      .filter((m) => m.channelId === channelId)
      .slice(-limit)
      .reverse()
      .map((m) => structuredClone(m));
  }

  // ── Delivery tracking ─────────────────────────────────────────────

  getDeliveryStatus(messageId: string): { messageId: string; deliveryStatus: DeliveryStatus; acknowledgedAt: string | null } | null {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return null;
    return {
      messageId: message.id,
      deliveryStatus: message.deliveryStatus,
      acknowledgedAt: message.acknowledgedAt,
    };
  }

  markDelivered(messageId: string): CommMessage | null {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return null;
    if (message.deliveryStatus === 'sent') {
      message.deliveryStatus = 'delivered';
    }
    return structuredClone(message);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private trimMessages(): void {
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES / 2);
    }
  }
}
