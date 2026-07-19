/**
 * src/ipc/Message.ts
 * Itera OS v2: IPC Message Definitions
 */

import { generateId } from '../utils/id';

export const PROTOCOL_VERSION = 'itera:ipc:v2';

export interface IpcMessageData {
  protocol: string;
  type: 'req' | 'res' | 'event';
  id: string;
  source: string;
  target: string;
  action: string;
  payload: any;
  error: string | null;
}

export class IpcMessage {
  static createRequest(source: string, target: string, action: string, payload: any = {}): IpcMessageData {
    return {
      protocol: PROTOCOL_VERSION,
      type: 'req',
      id: generateId(),
      source,
      target,
      action,
      payload,
      error: null,
    };
  }

  static createResponse(reqMessage: IpcMessageData, result: any, error: string | null = null): IpcMessageData {
    return {
      protocol: PROTOCOL_VERSION,
      type: 'res',
      id: reqMessage.id,
      source: reqMessage.target, // 返信元
      target: reqMessage.source, // 返信先
      action: reqMessage.action,
      payload: result,
      error: error ? String(error) : null,
    };
  }

  static createEvent(source: string, target: string, action: string, payload: any = {}): IpcMessageData {
    return {
      protocol: PROTOCOL_VERSION,
      type: 'event',
      id: generateId(),
      source,
      target,
      action,
      payload,
      error: null,
    };
  }

  static isValid(msg: any): msg is IpcMessageData {
    return !!(msg && msg.protocol === PROTOCOL_VERSION && msg.type && msg.source && msg.target);
  }
}
